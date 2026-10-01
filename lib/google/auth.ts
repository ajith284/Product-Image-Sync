import "server-only";

import type { GoogleConfig } from "@/lib/google/config";
import { saveGoogleConnection, verifyGoogleConnection, type GoogleDeps } from "@/lib/google/connection";
import { pkceChallenge, pkceVerifier } from "@/lib/google/crypto";
import { GoogleFlowError } from "@/lib/google/errors";
import { exchangeGoogleCode, GOOGLE_AUTHORIZE_URL, readIdToken } from "@/lib/google/tokens";
import { createOAuthState, hashOAuthState, OAUTH_STATE_TTL_SECONDS } from "@/lib/security/oauth-state";

/**
 * Google OAuth 2.0 for web server apps (authorization code + PKCE, offline access).
 *
 *   startGoogleOAuth()     → one-time state (hash in internal.oauth_states, 10 min,
 *                            bound to user + workspace + store) → Google consent URL
 *   handleGoogleCallback() → consume state → same signed-in user → Google error?
 *                            → ONLY THEN exchange code (+PKCE verifier) → granted
 *                            scopes → identity (ID token) → encrypt + save
 *                            → read-only verification (Drive about.get)
 */

const MAX_CODE_LENGTH = 2048;
const MAX_STATE_LENGTH = 128;

/** Consent URL. access_type=offline + prompt=consent → a refresh token every time (needed for background sync). */
export function buildGoogleAuthorizeUrl(
  params: { state: string },
  config: Pick<GoogleConfig, "clientId" | "redirectUri" | "requestScopes" | "tokenEncryptionKey">,
): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.requestScopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", pkceChallenge(pkceVerifier(params.state, config.tokenEncryptionKey)));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Start OAuth for a store. The caller must already have verified session,
 * workspace membership, owner/admin role and that the store is in the current
 * workspace; the database function re-checks all of it.
 */
export async function startGoogleOAuth(
  input: { userId: string; storeId: string },
  deps: Pick<GoogleDeps, "config" | "repo">,
): Promise<string> {
  const { state, stateHash } = createOAuthState();
  const storeId = await deps.repo
    .beginOAuth({ userId: input.userId, storeId: input.storeId, stateHash, ttlSeconds: OAUTH_STATE_TTL_SECONDS })
    .catch((error: unknown) => {
      throw error instanceof GoogleFlowError ? new GoogleFlowError(error.code, { storeId: input.storeId }) : error;
    });
  if (storeId !== input.storeId) throw new GoogleFlowError("store_mismatch", { storeId: input.storeId });
  return buildGoogleAuthorizeUrl({ state }, deps.config);
}

export type GoogleCallbackResult = { storeId: string; verified: boolean; email: string | null };

/**
 * Handle Google's redirect. Every check happens BEFORE the code exchange.
 * `sessionUserId` is the signed-in user of this browser (null if signed out).
 */
export async function handleGoogleCallback(
  input: { query: URLSearchParams; sessionUserId: string | null },
  deps: GoogleDeps,
): Promise<GoogleCallbackResult> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const q = input.query;

  // 1. State shape, then consume it exactly once (unknown / reused / expired rejected).
  const state = q.get("state");
  if (!state || state.length > MAX_STATE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new GoogleFlowError("invalid_state");
  }
  const consumed = await deps.repo.consumeState(hashOAuthState(state));
  if (consumed.status !== "ok") {
    throw new GoogleFlowError(
      consumed.status === "reused" ? "reused_state" : consumed.status === "expired" ? "expired_state" : "invalid_state",
    );
  }
  const { storeId } = consumed;

  // 2. Same signed-in user that started the flow.
  if (!input.sessionUserId || input.sessionUserId !== consumed.userId) {
    throw new GoogleFlowError("session_mismatch", { storeId });
  }

  // 3. The user declined, or Google reported an error.
  const googleError = q.get("error");
  if (googleError) {
    throw new GoogleFlowError(googleError === "access_denied" ? "access_denied" : "provider_error", { storeId });
  }
  const code = q.get("code");
  if (!code || code.length > MAX_CODE_LENGTH) throw new GoogleFlowError("invalid_request", { storeId });

  // 4. Only now: exchange the code (with the PKCE verifier bound to this state).
  const tokens = await exchangeGoogleCode(
    code,
    pkceVerifier(state, deps.config.tokenEncryptionKey),
    deps.config,
    deps.fetch ?? fetch,
    nowMs,
  ).catch((error: unknown) => {
    throw error instanceof GoogleFlowError ? new GoogleFlowError(error.code, { storeId }) : error;
  });

  // 5. Users can untick permissions on Google's consent screen: Drive access is required.
  const granted = tokens.scope.split(/\s+/).filter(Boolean);
  if (!granted.includes(deps.config.driveScope)) throw new GoogleFlowError("missing_scopes", { storeId });

  // 6. Who connected (stable Google account id + email).
  const identity = tokens.idToken ? readIdToken(tokens.idToken, deps.config.clientId, nowMs) : null;
  if (!identity) throw new GoogleFlowError("invalid_identity", { storeId });

  // 7. Encrypt + save (DB re-checks owner/admin, workspace and refresh-token rules).
  await saveGoogleConnection(
    {
      storeId,
      workspaceId: consumed.workspaceId,
      userId: consumed.userId,
      googleAccountId: identity.sub,
      googleAccountEmail: identity.emailVerified ? identity.email : null,
      scopes: granted.join(" "),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessExpiresAt: tokens.accessExpiresAt,
    },
    deps,
  );

  // 8. Read-only verification (Drive about.get).
  const verification = await verifyGoogleConnection(storeId, deps);
  return verification.ok
    ? { storeId, verified: true, email: verification.email }
    : { storeId, verified: false, email: identity.email };
}
