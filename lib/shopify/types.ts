import type { ShopDomain } from "@/lib/shopify/domain";

export type { ShopDomain } from "@/lib/shopify/domain";

/** Validated server-side Shopify app configuration (see lib/shopify/config.ts). */
export type ShopifyConfig = {
  clientId: string;
  /** Server-only. Never log, return from an API, or pass to a client component. */
  clientSecret: string;
  /** Base URL of this app, no trailing slash (e.g. http://localhost:3000). */
  appUrl: string;
  /** OAuth callback URL registered in the Shopify Dev Dashboard. */
  redirectUri: string;
  scopes: readonly string[];
  /** Admin API version, e.g. "2026-07". */
  apiVersion: string;
  /** Server-only 32-byte key (AES-256-GCM) for encrypting tokens at rest. */
  tokenEncryptionKey: Buffer;
};

export type ShopifyConfigStatus = {
  configured: boolean;
  /** Variable NAMES only — never values. */
  missing: string[];
  invalid: string[];
};

// ---------------------------------------------------------------------------
// GraphQL Admin API
// ---------------------------------------------------------------------------

export type ShopifyGraphQLError = {
  message: string;
  extensions?: { code?: string; [key: string]: unknown };
  path?: (string | number)[];
};

export type ShopifyGraphQLResponse<TData> = {
  data?: TData;
  errors?: ShopifyGraphQLError[];
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number | null;
      throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };
    };
  };
};

export type ShopifyApiErrorKind =
  | "unauthorized" // 401/403 — token revoked, expired or missing scope → reconnect
  | "payment_required" // 402 — shop frozen / unpaid
  | "not_found" // 404 — shop doesn't exist (or app uninstalled)
  | "locked" // 423 — shop locked
  | "throttled" // 429 or THROTTLED — retry later
  | "unavailable" // 5xx — Shopify-side problem
  | "graphql" // GraphQL errors in the response body
  | "network"; // DNS/timeout/connection

// ---------------------------------------------------------------------------
// OAuth (authorization code grant) — used by the next phase
// ---------------------------------------------------------------------------

/** Row shape for internal.oauth_states (only the hash of `state` is stored). */
export type OAuthStateRecord = {
  provider: "shopify";
  state_hash: string;
  user_id: string;
  workspace_id: string;
  store_id: string | null;
  shop_domain: ShopDomain;
  expires_at: string;
};

/** Response of POST https://{shop}/admin/oauth/access_token with expiring=1. */
export type ShopifyTokenResponse = {
  access_token: string;
  scope: string;
  /** Seconds until the access token expires (3600). */
  expires_in?: number;
  refresh_token?: string;
  /** Seconds until the refresh token expires (7776000 = 90 days). */
  refresh_token_expires_in?: number;
};
