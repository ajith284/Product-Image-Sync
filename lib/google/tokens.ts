import "server-only";

import type { GoogleConfig } from "@/lib/google/config";
import { GoogleFlowError } from "@/lib/google/errors";

/**
 * Google OAuth 2.0 token endpoint calls (web server flow).
 * Never logs or returns request/response bodies in errors.
 * https://developers.google.com/identity/protocols/oauth2/web-server
 */

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const TIMEOUT_MS = 15_000;
type FetchLike = typeof fetch;

export type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Space-separated scopes Google actually granted (users can untick some). */
  scope: string;
  accessExpiresAt: Date | null;
  idToken: string | null;
};

function toTokenSet(body: unknown, now: number): GoogleTokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !b.access_token) return null;
  const expiresIn = typeof b.expires_in === "number" && b.expires_in > 0 ? b.expires_in : null;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    scope: typeof b.scope === "string" ? b.scope : "",
    accessExpiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
    idToken: typeof b.id_token === "string" && b.id_token ? b.id_token : null,
  };
}

async function postForm(url: string, params: Record<string, string>, fetchImpl: FetchLike) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Exchange the authorization code (with the PKCE verifier). Call ONLY after the callback is validated. */
export async function exchangeGoogleCode(
  code: string,
  codeVerifier: string,
  config: Pick<GoogleConfig, "clientId" | "clientSecret" | "redirectUri">,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<GoogleTokenSet> {
  let result: { status: number; body: unknown };
  try {
    result = await postForm(
      GOOGLE_TOKEN_URL,
      {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      },
      fetchImpl,
    );
  } catch {
    throw new GoogleFlowError("exchange_failed");
  }
  const tokens = result.status >= 200 && result.status < 300 ? toTokenSet(result.body, now) : null;
  if (!tokens) throw new GoogleFlowError("exchange_failed");
  return tokens;
}

export type GoogleRefreshResult =
  | { ok: true; tokens: GoogleTokenSet }
  | { ok: false; reason: "rejected" | "unavailable" };

/**
 * Get a new access token. "rejected" (invalid_grant: revoked, expired — e.g. the
 * 7-day limit for apps in Testing — or password change) → user must reconnect.
 * "unavailable" = transient; try again later.
 */
export async function refreshGoogleAccessToken(
  refreshToken: string,
  config: Pick<GoogleConfig, "clientId" | "clientSecret">,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<GoogleRefreshResult> {
  let result: { status: number; body: unknown };
  try {
    result = await postForm(
      GOOGLE_TOKEN_URL,
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
      fetchImpl,
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (result.status >= 500 || result.status === 429) return { ok: false, reason: "unavailable" };
  const tokens = result.status >= 200 && result.status < 300 ? toTokenSet(result.body, now) : null;
  return tokens ? { ok: true, tokens } : { ok: false, reason: "rejected" };
}

/**
 * Best-effort revoke. NOTE: Google revokes the whole grant (this Google
 * account ↔ this app), so callers must not revoke while another store still
 * uses the same Google account.
 */
export async function revokeGoogleToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await postForm(GOOGLE_REVOKE_URL, { token }, fetchImpl);
    return res.status === 200;
  } catch {
    return false;
  }
}

export type GoogleIdentity = { sub: string; email: string | null; emailVerified: boolean };

/**
 * Reads the ID token received DIRECTLY from Google's token endpoint over TLS,
 * authenticated with our client secret — per Google's OpenID Connect guide the
 * signature check can be skipped in this case. We still check iss, aud, exp and sub.
 */
export function readIdToken(idToken: string, clientId: string, now = Date.now()): GoogleIdentity | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const iss = payload.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") return null;
  const aud = payload.aud;
  if (!(aud === clientId || (Array.isArray(aud) && aud.includes(clientId)))) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now - 60_000) return null;
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) return null;
  const email = typeof payload.email === "string" && payload.email.length <= 320 ? payload.email : null;
  return { sub: payload.sub, email, emailVerified: payload.email_verified === true };
}
