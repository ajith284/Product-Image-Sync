import "server-only";

import { createShopifyClient, ShopifyApiError } from "@/lib/shopify/client";
import { decryptToken, encryptToken, tokenContext, TokenDecryptionError } from "@/lib/shopify/crypto";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import { isValidShopDomain } from "@/lib/shopify/domain";
import type { ShopifyRepository, StoredCredentials } from "@/lib/shopify/repository";
import { refreshAccessToken } from "@/lib/shopify/tokens";
import type { ShopDomain, ShopifyConfig } from "@/lib/shopify/types";

/**
 * Server-only connection service: token refresh, read-only verification and
 * disconnect. Tokens are decrypted just-in-time and never leave this module
 * except to the Shopify API.
 */

export type ConnectionDeps = {
  config: ShopifyConfig;
  repo: ShopifyRepository;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const now = (deps: ConnectionDeps) => (deps.now ? deps.now() : Date.now());

async function markNeedsReconnect(deps: ConnectionDeps, storeId: string) {
  await deps.repo.recordVerification({
    storeId,
    ok: false,
    failureStatus: "needs_reconnect",
    error: "Shopify needs to be reconnected.",
  });
}

function decrypt(value: string | null, deps: ConnectionDeps, storeId: string, shop: string, kind: "access" | "refresh") {
  if (!value) return null;
  return decryptToken(value, deps.config.tokenEncryptionKey, tokenContext(storeId, shop, kind));
}

/**
 * Returns a usable access token for the store, refreshing it first when it is
 * about to expire. Concurrent refreshes are resolved with optimistic locking
 * (token_version): the loser re-reads the winner's tokens.
 */
export async function refreshTokenIfNeeded(
  storeId: string,
  deps: ConnectionDeps,
): Promise<{ accessToken: string; shop: ShopDomain; credentials: StoredCredentials }> {
  const creds = await deps.repo.getCredentials(storeId);
  if (!creds || !creds.encryptedAccessToken) throw new ShopifyFlowError("not_connected", { storeId });
  if (!isValidShopDomain(creds.shopDomain)) throw new ShopifyFlowError("invalid_shop_domain", { storeId });
  const shop = creds.shopDomain;

  let accessToken: string | null;
  try {
    accessToken = decrypt(creds.encryptedAccessToken, deps, storeId, shop, "access");
  } catch (error) {
    if (error instanceof TokenDecryptionError) {
      // Wrong/rotated encryption key or tampered row: the merchant must reconnect.
      await markNeedsReconnect(deps, storeId);
      throw new ShopifyFlowError("needs_reconnect", { storeId });
    }
    throw error;
  }

  const t = now(deps);
  const fresh = !creds.tokenExpiresAt || creds.tokenExpiresAt.getTime() - t > REFRESH_MARGIN_MS;
  if (fresh && accessToken) return { accessToken, shop, credentials: creds };

  const refreshExpired = creds.refreshTokenExpiresAt && creds.refreshTokenExpiresAt.getTime() <= t;
  let refreshToken: string | null = null;
  try {
    refreshToken = refreshExpired ? null : decrypt(creds.encryptedRefreshToken, deps, storeId, shop, "refresh");
  } catch {
    refreshToken = null;
  }
  if (!refreshToken) {
    await markNeedsReconnect(deps, storeId);
    throw new ShopifyFlowError("needs_reconnect", { storeId });
  }

  const result = await refreshAccessToken(shop, refreshToken, deps.config, deps.fetch ?? fetch, t);
  if (!result.ok) {
    if (result.reason === "rejected") {
      await markNeedsReconnect(deps, storeId);
      throw new ShopifyFlowError("needs_reconnect", { storeId });
    }
    throw new ShopifyFlowError("verify_failed", { storeId });
  }

  const key = deps.config.tokenEncryptionKey;
  const saved = await deps.repo.storeRefreshedTokens({
    connectionId: creds.connectionId,
    expectedVersion: creds.tokenVersion,
    encryptedAccessToken: encryptToken(result.tokens.accessToken, key, tokenContext(storeId, shop, "access")),
    encryptedRefreshToken: result.tokens.refreshToken
      ? encryptToken(result.tokens.refreshToken, key, tokenContext(storeId, shop, "refresh"))
      : null,
    accessExpiresAt: result.tokens.accessExpiresAt,
    refreshExpiresAt: result.tokens.refreshExpiresAt,
  });

  if (saved) {
    return { accessToken: result.tokens.accessToken, shop, credentials: creds };
  }

  // Another process refreshed first — use what it stored.
  const latest = await deps.repo.getCredentials(storeId);
  const latestAccess = latest ? decrypt(latest.encryptedAccessToken, deps, storeId, shop, "access") : null;
  if (!latest || !latestAccess) throw new ShopifyFlowError("verify_failed", { storeId });
  return { accessToken: latestAccess, shop, credentials: latest };
}

const VERIFY_QUERY = /* GraphQL */ `
  query VerifyConnection {
    shop {
      id
      name
      myshopifyDomain
    }
    products(first: 1) {
      edges {
        node {
          id
        }
      }
    }
  }
`;

type VerifyData = {
  shop: { id: string; name: string; myshopifyDomain: string };
  products: { edges: { node: { id: string } }[] };
};

export type VerifyResult =
  | { ok: true; shopName: string }
  | { ok: false; code: "needs_reconnect" | "verify_failed" | "not_connected"; message: string };

/**
 * READ-ONLY check: reads shop info and one product. Never modifies Shopify data.
 * Records the result (connected / needs_reconnect / error) on the connection.
 */
export async function verifyConnection(
  storeId: string,
  deps: ConnectionDeps,
  opts: { log?: boolean } = {},
): Promise<VerifyResult> {
  let access: Awaited<ReturnType<typeof refreshTokenIfNeeded>>;
  try {
    access = await refreshTokenIfNeeded(storeId, deps);
  } catch (error) {
    if (error instanceof ShopifyFlowError && (error.code === "needs_reconnect" || error.code === "not_connected")) {
      return { ok: false, code: error.code, message: error.userMessage };
    }
    return { ok: false, code: "verify_failed", message: "We couldn't verify the Shopify connection. Please try again shortly." };
  }

  const client = createShopifyClient({
    shop: access.shop,
    accessToken: access.accessToken,
    apiVersion: deps.config.apiVersion,
    fetch: deps.fetch,
  });

  try {
    const { data } = await client.graphql<VerifyData>(VERIFY_QUERY);
    if (data.shop.myshopifyDomain.toLowerCase() !== access.shop) {
      await deps.repo.recordVerification({
        storeId,
        ok: false,
        failureStatus: "error",
        error: "Shopify returned a different store than expected. Please reconnect.",
        log: opts.log,
      });
      return { ok: false, code: "verify_failed", message: "Shopify returned a different store than expected. Please reconnect." };
    }
    await deps.repo.recordVerification({ storeId, ok: true, shopifyShopId: data.shop.id, log: opts.log });
    return { ok: true, shopName: data.shop.name };
  } catch (error) {
    if (error instanceof ShopifyApiError) {
      if (error.kind === "unauthorized" || error.kind === "not_found") {
        await deps.repo.recordVerification({
          storeId,
          ok: false,
          failureStatus: "needs_reconnect",
          error: error.userMessage,
          log: opts.log,
        });
        return { ok: false, code: "needs_reconnect", message: error.userMessage };
      }
      if (!error.retryable) {
        await deps.repo.recordVerification({ storeId, ok: false, failureStatus: "error", error: error.userMessage, log: opts.log });
      }
      // Transient problems (throttled / unavailable / network) don't change the stored status.
      return { ok: false, code: "verify_failed", message: error.userMessage };
    }
    throw error;
  }
}

/**
 * Disconnect: best-effort appUninstall on Shopify (revokes the app's tokens and
 * removes it from the merchant's store), then ALWAYS delete stored credentials
 * and mark the connection disconnected. History (sync jobs, activity, mappings)
 * is preserved. Caller must have authorized the user first; the SQL function
 * re-checks owner/admin.
 */
export async function disconnectStore(storeId: string, userId: string, deps: ConnectionDeps): Promise<void> {
  try {
    const access = await refreshTokenIfNeeded(storeId, deps);
    const client = createShopifyClient({
      shop: access.shop,
      accessToken: access.accessToken,
      apiVersion: deps.config.apiVersion,
      fetch: deps.fetch,
      timeoutMs: 10_000,
    });
    await client.graphql(`mutation AppUninstall { appUninstall { userErrors { field message } } }`);
  } catch {
    // Ignore: local credentials are removed regardless. The app/uninstalled
    // webhook (if it arrives) is handled idempotently.
  }
  await deps.repo.disconnect(storeId, userId);
}
