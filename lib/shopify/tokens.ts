import "server-only";

import { ShopifyFlowError } from "@/lib/shopify/errors";
import type { ShopDomain, ShopifyConfig, ShopifyTokenResponse } from "@/lib/shopify/types";

/**
 * Shopify OAuth token endpoint calls (authorization code grant, expiring
 * offline tokens). Never logs or returns request/response bodies in errors.
 */

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
};

type FetchLike = typeof fetch;
const TIMEOUT_MS = 15_000;

function toTokenSet(body: unknown, now: number): TokenSet | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<ShopifyTokenResponse>;
  if (typeof b.access_token !== "string" || !b.access_token) return null;
  const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const expiresIn = seconds(b.expires_in);
  const refreshIn = seconds(b.refresh_token_expires_in);
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    scope: typeof b.scope === "string" ? b.scope : "",
    accessExpiresAt: expiresIn ? new Date(now + expiresIn * 1000) : null,
    refreshExpiresAt: refreshIn ? new Date(now + refreshIn * 1000) : null,
  };
}

async function postTokenEndpoint(
  shop: ShopDomain,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
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

/** Exchange the authorization code for an expiring offline token. Call ONLY after the callback is validated. */
export async function exchangeToken(
  shop: ShopDomain,
  code: string,
  config: Pick<ShopifyConfig, "clientId" | "clientSecret">,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  let result: { status: number; body: unknown };
  try {
    result = await postTokenEndpoint(
      shop,
      { client_id: config.clientId, client_secret: config.clientSecret, code, expiring: "1" },
      fetchImpl,
    );
  } catch {
    throw new ShopifyFlowError("exchange_failed");
  }
  const tokens = result.status >= 200 && result.status < 300 ? toTokenSet(result.body, now) : null;
  if (!tokens) throw new ShopifyFlowError("exchange_failed");
  return tokens;
}

export type RefreshResult = { ok: true; tokens: TokenSet } | { ok: false; reason: "rejected" | "unavailable" };

/**
 * Refresh an expiring offline token. "rejected" = refresh token invalid/expired
 * (merchant must reconnect); "unavailable" = transient, retry later.
 */
export async function refreshAccessToken(
  shop: ShopDomain,
  refreshToken: string,
  config: Pick<ShopifyConfig, "clientId" | "clientSecret">,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<RefreshResult> {
  let result: { status: number; body: unknown };
  try {
    result = await postTokenEndpoint(
      shop,
      {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
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
