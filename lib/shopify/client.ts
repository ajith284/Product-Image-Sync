import "server-only";

import { isValidShopDomain } from "@/lib/shopify/domain";
import type {
  ShopDomain,
  ShopifyApiErrorKind,
  ShopifyGraphQLError,
  ShopifyGraphQLResponse,
} from "@/lib/shopify/types";

/**
 * Minimal server-only client for the Shopify GraphQL Admin API.
 *
 * - One client per shop + access token; create it inside the request/job that
 *   needs it. Never cache it globally and never pass it to the browser.
 * - Obtaining/refreshing/decrypting the access token is NOT done here (next phase).
 * - Errors never contain the access token.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

/** Customer-facing messages (see PROJECT_SPEC.md: no raw API errors in the UI). */
const USER_MESSAGES: Record<ShopifyApiErrorKind, string> = {
  unauthorized: "Shopify needs to be reconnected.",
  payment_required: "This Shopify store is unavailable (billing or plan issue).",
  not_found: "We couldn't find this Shopify store. It may have removed the app.",
  locked: "This Shopify store is temporarily locked.",
  throttled: "Shopify is busy right now. We'll try again shortly.",
  unavailable: "Shopify is temporarily unavailable. We'll try again shortly.",
  graphql: "Shopify rejected the request.",
  network: "We couldn't reach Shopify. We'll try again shortly.",
};

export class ShopifyApiError extends Error {
  readonly kind: ShopifyApiErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly graphqlErrors?: ShopifyGraphQLError[];

  constructor(
    kind: ShopifyApiErrorKind,
    detail: string,
    opts: { status?: number; retryAfterSeconds?: number; graphqlErrors?: ShopifyGraphQLError[] } = {},
  ) {
    super(`Shopify API ${kind}: ${detail}`);
    this.name = "ShopifyApiError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.graphqlErrors = opts.graphqlErrors;
  }

  /** Safe to show to customers. */
  get userMessage() {
    return USER_MESSAGES[this.kind];
  }

  /** Whether a background job should retry later. */
  get retryable() {
    return this.kind === "throttled" || this.kind === "unavailable" || this.kind === "network";
  }
}

export type ShopifyClientOptions = {
  shop: ShopDomain | string;
  /** Plaintext access token, decrypted just-in-time by server code (next phase). */
  accessToken: string;
  /** Admin API version, normally getShopifyConfig().apiVersion. */
  apiVersion: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
};

export type ShopifyAdminClient = {
  readonly shop: ShopDomain;
  readonly apiVersion: string;
  graphql<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables?: TVariables,
  ): Promise<{ data: TData; extensions?: ShopifyGraphQLResponse<TData>["extensions"] }>;
};

function statusToKind(status: number): ShopifyApiErrorKind | null {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 404) return "not_found";
  if (status === 423) return "locked";
  if (status === 429) return "throttled";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "graphql";
  return null;
}

export function createShopifyClient(options: ShopifyClientOptions): ShopifyAdminClient {
  if (!isValidShopDomain(options.shop)) {
    throw new Error("createShopifyClient: shop must be a validated *.myshopify.com domain");
  }
  if (!options.accessToken) throw new Error("createShopifyClient: accessToken is required");
  if (!/^\d{4}-(01|04|07|10)$/.test(options.apiVersion)) {
    throw new Error("createShopifyClient: apiVersion must look like 2026-07");
  }

  const shop = options.shop;
  const endpoint = `https://${shop}/admin/api/${options.apiVersion}/graphql.json`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    shop,
    apiVersion: options.apiVersion,
    async graphql<TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      variables?: TVariables,
    ) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Shopify-Access-Token": options.accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown";
        throw new ShopifyApiError("network", `request to ${shop} failed (${reason})`);
      }

      const kind = statusToKind(res.status);
      if (kind) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        throw new ShopifyApiError(kind, `HTTP ${res.status} from ${shop}`, {
          status: res.status,
          retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        });
      }

      let body: ShopifyGraphQLResponse<TData>;
      try {
        body = (await res.json()) as ShopifyGraphQLResponse<TData>;
      } catch {
        throw new ShopifyApiError("unavailable", `invalid JSON from ${shop}`, { status: res.status });
      }

      if (body.errors?.length) {
        const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
        throw new ShopifyApiError(
          throttled ? "throttled" : "graphql",
          body.errors.map((e) => e.message).join("; ").slice(0, 500),
          { status: res.status, graphqlErrors: body.errors },
        );
      }
      if (body.data === undefined) {
        throw new ShopifyApiError("graphql", `empty response from ${shop}`, { status: res.status });
      }
      return { data: body.data, extensions: body.extensions };
    },
  };
}
