import "server-only";

import { filterMatchingProducts, normalizeMatchText } from "@/lib/matching/product-match";
import { createShopifyClient, ShopifyApiError } from "@/lib/shopify/client";
import { refreshTokenIfNeeded, type ConnectionDeps } from "@/lib/shopify/connection";
import { ShopifyFlowError } from "@/lib/shopify/errors";

/**
 * Server-only, READ-ONLY Shopify product search (GraphQL Admin API).
 *
 * Reuses the store's existing connection: the access token is obtained via
 * refreshTokenIfNeeded() and used only for the request to Shopify. Nothing
 * returned from here contains tokens or secrets — only the safe fields below.
 *
 * The CALLER must authorize first (user → workspace → store → connection);
 * see app/api/shopify/products/search/route.ts.
 */

/** Every product status — Shopify's product search is ACTIVE-only unless told otherwise. */
export const ALL_PRODUCT_STATUSES = ["active", "archived", "draft", "unlisted"] as const;

export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_MAX_PAGES = 5;
const MAX_TERM_WORDS = 8;
export const MAX_SEARCH_TERM_LENGTH = 120;

export type ProductSummary = {
  /** Shopify GraphQL ID, e.g. gid://shopify/Product/123 */
  id: string;
  /** Numeric ID shown in Shopify admin URLs. */
  legacyResourceId: string;
  title: string;
  handle: string;
  /** ACTIVE | DRAFT | ARCHIVED | UNLISTED — displayed only, never changed. */
  status: string;
  vendor: string;
  productType: string;
  /** null when Shopify doesn't return an exact count. */
  mediaCount: number | null;
};

export type ProductSearchResult = {
  products: ProductSummary[];
  /** True when more candidates existed than we scanned (SEARCH_MAX_PAGES × SEARCH_PAGE_SIZE). */
  truncated: boolean;
};

export const PRODUCT_SEARCH_QUERY = /* GraphQL */ `
  query SearchProducts($query: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      nodes {
        id
        legacyResourceId
        title
        handle
        status
        vendor
        productType
        mediaCount {
          count
          precision
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type SearchData = {
  products: {
    nodes: {
      id: string;
      legacyResourceId: string;
      title: string;
      handle: string;
      status: string;
      vendor: string;
      productType: string;
      mediaCount: { count: number; precision: string } | null;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

/**
 * Builds the Shopify search string used to FETCH CANDIDATES:
 *   title:milano* AND title:3* AND status:active,archived,draft,unlisted
 * Words are split on anything that isn't a letter or digit, so the string can
 * never contain search-syntax characters (no injection of `OR`, `:` etc.
 * beyond what we write). The exact "title contains" rule is applied afterwards
 * in code, so this only has to be broad enough.
 * Returns null when the term has no letters/digits (nothing can be searched).
 */
export function buildProductSearchQuery(searchTerm: string): string | null {
  const words = normalizeMatchText(searchTerm)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_TERM_WORDS);
  if (words.length === 0) return null;
  const titleClauses = words.map((w) => `title:${w}*`);
  return [...titleClauses, `status:${ALL_PRODUCT_STATUSES.join(",")}`].join(" AND ");
}

function toSummary(node: SearchData["products"]["nodes"][number]): ProductSummary {
  return {
    id: node.id,
    legacyResourceId: String(node.legacyResourceId),
    title: node.title,
    handle: node.handle,
    status: node.status,
    vendor: node.vendor,
    productType: node.productType,
    mediaCount: node.mediaCount && node.mediaCount.precision === "EXACT" ? node.mediaCount.count : null,
  };
}

/**
 * Returns ALL products of the store whose title contains `searchTerm`
 * (case-insensitive, whitespace-normalized), in any status. Never selects one,
 * never creates or modifies anything.
 */
export async function searchProducts(
  input: { storeId: string; searchTerm: string },
  deps: ConnectionDeps,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<ProductSearchResult> {
  const term = input.searchTerm.slice(0, MAX_SEARCH_TERM_LENGTH);
  const query = buildProductSearchQuery(term);
  if (!query) return { products: [], truncated: false };

  const access = await refreshTokenIfNeeded(input.storeId, deps);
  const client = createShopifyClient({
    shop: access.shop,
    accessToken: access.accessToken,
    apiVersion: deps.config.apiVersion,
    fetch: deps.fetch,
  });

  const pageSize = opts.pageSize ?? SEARCH_PAGE_SIZE;
  const maxPages = opts.maxPages ?? SEARCH_MAX_PAGES;
  const candidates: ProductSummary[] = [];
  let after: string | null = null;
  let truncated = false;

  try {
    for (let page = 0; page < maxPages; page++) {
      const { data }: { data: SearchData } = await client.graphql<SearchData>(PRODUCT_SEARCH_QUERY, {
        query,
        first: pageSize,
        after,
      });
      candidates.push(...data.products.nodes.map(toSummary));
      if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break;
      after = data.products.pageInfo.endCursor;
      if (page === maxPages - 1) truncated = true;
    }
  } catch (error) {
    if (error instanceof ShopifyApiError && (error.kind === "unauthorized" || error.kind === "not_found")) {
      // Token revoked / app removed: same handling as Verify.
      await deps.repo.recordVerification({
        storeId: input.storeId,
        ok: false,
        failureStatus: "needs_reconnect",
        error: error.userMessage,
      });
      throw new ShopifyFlowError("needs_reconnect", { storeId: input.storeId });
    }
    throw error;
  }

  // Exact rule from PROJECT_SPEC §6: normalized title CONTAINS normalized term.
  return { products: filterMatchingProducts(term, candidates), truncated };
}
