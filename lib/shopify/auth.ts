import "server-only";

import { verifyConnection, type ConnectionDeps } from "@/lib/shopify/connection";
import { encryptToken, tokenContext } from "@/lib/shopify/crypto";
import { isValidShopDomain, normalizeShopDomain } from "@/lib/shopify/domain";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import { buildAuthorizeUrl, createOAuthState, hashOAuthState, OAUTH_STATE_TTL_SECONDS, verifyShopifyHmac } from "@/lib/shopify/oauth";
import { hasRequiredScopes } from "@/lib/shopify/scopes";
import { exchangeToken } from "@/lib/shopify/tokens";
import type { ShopDomain } from "@/lib/shopify/types";

/**
 * Shopify OAuth (authorization code grant, expiring offline tokens).
 *
 *   startOAuth()      → state (hash stored, 10 min, one-time) → Shopify approval URL
 *   handleCallback()  → validate shop, HMAC, timestamp, state, session, shop match
 *                       → ONLY THEN exchange code → check scopes → encrypt → save
 *                       → read-only verification
 */

/** Accept callbacks whose `timestamp` is within this window (seconds). */
const MAX_CALLBACK_AGE_SECONDS = 5 * 60;
const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * Start OAuth for a store. The caller must already have verified the user's
 * session, workspace membership and owner/admin role and that the store is in
 * the current workspace; the database function re-checks all of it.
 */
export async function startOAuth(
  input: { userId: string; storeId: string; storeShopDomain: string | null },
  deps: Pick<ConnectionDeps, "config" | "repo">,
): Promise<string> {
  // Never build an OAuth URL from unchecked input: re-validate the stored domain.
  const shop = normalizeShopDomain(input.storeShopDomain);
  if (!shop || shop !== input.storeShopDomain) throw new ShopifyFlowError("invalid_shop_domain", { storeId: input.storeId });

  const { state, stateHash } = createOAuthState();
  const savedShop = await deps.repo.beginOAuth({
    userId: input.userId,
    storeId: input.storeId,
    stateHash,
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
  });
  if (savedShop !== shop) throw new ShopifyFlowError("store_mismatch", { storeId: input.storeId });

  return buildAuthorizeUrl({ shop, state }, deps.config);
}

/** Pure validation of the callback query (no DB, no network). Throws ShopifyFlowError. */
export function validateCallbackQuery(
  query: URLSearchParams,
  clientSecret: string,
  nowMs: number,
): { code: string; shop: ShopDomain; state: string } {
  const code = query.get("code");
  const shop = query.get("shop");
  const state = query.get("state");
  const timestamp = query.get("timestamp");
  if (!code || !shop || !state || !timestamp || !query.get("hmac")) throw new ShopifyFlowError("invalid_request");
  if (!isValidShopDomain(shop)) throw new ShopifyFlowError("invalid_shop_domain");
  if (!verifyShopifyHmac(query, clientSecret)) throw new ShopifyFlowError("invalid_hmac");

  const ts = Number(timestamp);
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isInteger(ts) || ts > nowSec + MAX_CLOCK_SKEW_SECONDS || nowSec - ts > MAX_CALLBACK_AGE_SECONDS) {
    throw new ShopifyFlowError("stale_request");
  }
  if (code.length > 512 || state.length > 128) throw new ShopifyFlowError("invalid_request");
  return { code, shop, state };
}

export type CallbackResult = { storeId: string; verified: boolean; verifyMessage?: string };

/**
 * Handle Shopify's redirect. Every check happens BEFORE the code exchange.
 * `sessionUserId` is the signed-in user of this browser (null if signed out).
 */
export async function handleCallback(
  input: { query: URLSearchParams; sessionUserId: string | null },
  deps: ConnectionDeps,
): Promise<CallbackResult> {
  const nowMs = deps.now ? deps.now() : Date.now();

  // 1. Shape, shop domain, HMAC, timestamp.
  const { code, shop, state } = validateCallbackQuery(input.query, deps.config.clientSecret, nowMs);

  // 2. One-time state (unknown / reused / expired are rejected; consumed atomically).
  const consumed = await deps.repo.consumeState(hashOAuthState(state));
  if (consumed.status !== "ok") {
    throw new ShopifyFlowError(
      consumed.status === "reused" ? "reused_state" : consumed.status === "expired" ? "expired_state" : "invalid_state",
    );
  }
  const { storeId } = consumed;

  // 3. Expected OAuth session: same signed-in user, same shop as when it started.
  if (!input.sessionUserId || input.sessionUserId !== consumed.userId) {
    throw new ShopifyFlowError("session_mismatch", { storeId });
  }
  if (consumed.shopDomain !== shop) throw new ShopifyFlowError("shop_mismatch", { storeId });

  // 4. Only now: exchange the code (expiring offline token).
  const tokens = await exchangeToken(shop, code, deps.config, deps.fetch ?? fetch, nowMs).catch((error: unknown) => {
    throw error instanceof ShopifyFlowError ? new ShopifyFlowError(error.code, { storeId }) : error;
  });
  if (!hasRequiredScopes(tokens.scope)) throw new ShopifyFlowError("missing_scopes", { storeId });

  // 5. Encrypt, then save connection + secrets atomically (re-checks permission).
  const key = deps.config.tokenEncryptionKey;
  await deps.repo
    .saveConnection({
      storeId,
      workspaceId: consumed.workspaceId,
      userId: consumed.userId,
      shopDomain: shop,
      scopes: tokens.scope,
      encryptedAccessToken: encryptToken(tokens.accessToken, key, tokenContext(storeId, shop, "access")),
      encryptedRefreshToken: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, key, tokenContext(storeId, shop, "refresh"))
        : null,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    })
    .catch((error: unknown) => {
      throw error instanceof ShopifyFlowError ? new ShopifyFlowError(error.code, { storeId }) : error;
    });

  // 6. Read-only verification (shop info + one product).
  const verification = await verifyConnection(storeId, deps);
  return verification.ok
    ? { storeId, verified: true }
    : { storeId, verified: false, verifyMessage: verification.message };
}
