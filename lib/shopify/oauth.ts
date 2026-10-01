import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getShopifyConfig } from "@/lib/shopify/config";
import type { ShopDomain, ShopifyConfig } from "@/lib/shopify/types";

/**
 * Low-level OAuth helpers for the authorization code grant (non-embedded app).
 * The flow itself lives in lib/shopify/auth.ts:
 *
 *   1. /api/shopify/auth   verify user → workspace → owner/admin → store belongs
 *                          to workspace; createOAuthState(); save stateHash in
 *                          internal.oauth_states (10 min TTL); redirect to
 *                          buildAuthorizeUrl().
 *   2. Shopify approval screen.
 *   3. /api/shopify/callback  isValidShopDomain(shop) + verifyShopifyHmac() +
 *                          state hash lookup (unused, unexpired, same user/shop);
 *                          POST /admin/oauth/access_token with expiring=1;
 *                          hasRequiredScopes(); encrypt tokens → internal.integration_secrets;
 *                          metadata → shopify_connections; store.status = connected.
 */

export { createOAuthState, hashOAuthState, OAUTH_STATE_TTL_SECONDS } from "@/lib/security/oauth-state";

/**
 * https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state
 * No grant_options[] → offline (app-level) access, required for background sync.
 */
export function buildAuthorizeUrl(
  params: { shop: ShopDomain; state: string },
  config: Pick<ShopifyConfig, "clientId" | "scopes" | "redirectUri"> = getShopifyConfig(),
): string {
  const url = new URL(`https://${params.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("scope", config.scopes.join(","));
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

/**
 * Verifies the `hmac` Shopify adds to OAuth redirects: remove `hmac`, sort the
 * remaining params, join as `key=value` with `&`, HMAC-SHA256 with the client
 * secret, compare in constant time.
 */
export function verifyShopifyHmac(query: URLSearchParams, clientSecret: string = getShopifyConfig().clientSecret): boolean {
  const received = query.get("hmac");
  if (!received || !/^[a-f0-9]{64}$/i.test(received)) return false;

  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const expected = createHmac("sha256", clientSecret).update(message).digest();
  const actual = Buffer.from(received, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
