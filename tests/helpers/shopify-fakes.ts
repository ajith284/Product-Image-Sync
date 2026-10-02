import { createHmac } from "node:crypto";

import { vi } from "vitest";

import type { ConsumedState, SaveConnectionInput, ShopifyRepository, StoredCredentials } from "@/lib/shopify/repository";
import type { ShopifyConfig } from "@/lib/shopify/types";

export const SHOP = "royal-sofa.myshopify.com";
export const STORE_ID = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const USER_ID = "33333333-3333-4333-8333-333333333333";
export const NOW = 1_790_000_000_000;

export const config: ShopifyConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  appUrl: "http://localhost:3000",
  redirectUri: "http://localhost:3000/api/shopify/callback",
  scopes: ["read_products", "write_products", "write_files"],
  apiVersion: "2026-07",
  tokenEncryptionKey: Buffer.alloc(32, 9),
};

/** Builds a callback query signed like Shopify does. */
export function signedCallback(params: Record<string, string>, secret = config.clientSecret) {
  const q = new URLSearchParams(params);
  const message = [...q.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  q.set("hmac", createHmac("sha256", secret).update(message).digest("hex"));
  return q;
}

/** In-memory repository mirroring the SQL functions' semantics. */
export function fakeRepo(overrides: Partial<ShopifyRepository> = {}) {
  const state: {
    consumed: ConsumedState;
    saved: SaveConnectionInput | null;
    creds: StoredCredentials | null;
    verifications: Parameters<ShopifyRepository["recordVerification"]>[0][];
  } = {
    consumed: { status: "ok", userId: USER_ID, workspaceId: WORKSPACE_ID, storeId: STORE_ID, shopDomain: SHOP },
    saved: null,
    creds: null,
    verifications: [],
  };

  const repo: ShopifyRepository = {
    beginOAuth: vi.fn(async () => SHOP),
    consumeState: vi.fn(async () => state.consumed),
    saveConnection: vi.fn(async (input: SaveConnectionInput) => {
      state.saved = input;
      state.creds = {
        connectionId: "conn-1",
        workspaceId: input.workspaceId,
        shopDomain: input.shopDomain,
        connectionStatus: "pending",
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken,
        tokenExpiresAt: input.accessExpiresAt,
        refreshTokenExpiresAt: input.refreshExpiresAt,
        tokenVersion: 1,
      };
      return "conn-1";
    }),
    getCredentials: vi.fn(async () => state.creds),
    storeRefreshedTokens: vi.fn(async (input: Parameters<ShopifyRepository["storeRefreshedTokens"]>[0]) => {
      if (!state.creds || state.creds.tokenVersion !== input.expectedVersion) return false;
      state.creds = {
        ...state.creds,
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken ?? state.creds.encryptedRefreshToken,
        tokenExpiresAt: input.accessExpiresAt,
        refreshTokenExpiresAt: input.refreshExpiresAt ?? state.creds.refreshTokenExpiresAt,
        tokenVersion: state.creds.tokenVersion + 1,
      };
      return true;
    }),
    recordVerification: vi.fn(async (input: Parameters<ShopifyRepository["recordVerification"]>[0]) => {
      state.verifications.push(input);
    }),
    disconnect: vi.fn(async () => true),
    handleAppUninstalled: vi.fn(async () => "disconnected"),
    handleShopRedact: vi.fn(async () => "redacted"),
    recordWebhook: vi.fn(async () => true),
    ...overrides,
  };
  return { repo, state };
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** fetch mock routing the token endpoint and GraphQL separately. */
export function shopifyFetch(routes: { token?: Route; graphql?: Route }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/admin/oauth/access_token") && routes.token) return routes.token(url, init ?? {});
    if (url.includes("/graphql.json") && routes.graphql) return routes.graphql(url, init ?? {});
    throw new Error(`unexpected fetch ${url}`);
  });
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  json({
    access_token: "shpat_ACCESS_SECRET_1",
    scope: "read_products,write_products,write_files",
    expires_in: 3600,
    refresh_token: "shprt_REFRESH_SECRET_1",
    refresh_token_expires_in: 7_776_000,
    ...overrides,
  });

export const verifyResponse = (domain = SHOP) =>
  json({
    data: {
      shop: { id: "gid://shopify/Shop/42", name: "Royal Sofa", myshopifyDomain: domain },
      products: { edges: [{ node: { id: "gid://shopify/Product/1" } }] },
    },
  });
