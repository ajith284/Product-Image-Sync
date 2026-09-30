import { describe, expect, it, vi } from "vitest";

import { encryptToken, tokenContext } from "@/lib/shopify/crypto";
import type { ConnectionDeps } from "@/lib/shopify/connection";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import {
  ALL_PRODUCT_STATUSES,
  buildProductSearchQuery,
  PRODUCT_SEARCH_QUERY,
  searchProducts,
} from "@/lib/shopify/products";
import { config, fakeRepo, json, NOW, SHOP, STORE_ID, WORKSPACE_ID } from "./helpers/shopify-fakes";

const ACCESS = "shpat_ACCESS_SECRET_1";
const REFRESH = "shprt_REFRESH_SECRET_1";

type P = { title: string; status: "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED"; media?: number };

const CATALOG: P[] = [
  { title: "Milano 3 Seater Sofa", status: "ACTIVE", media: 4 },
  { title: "Milano Corner Sofa", status: "DRAFT", media: 0 },
  { title: "Milano Recliner", status: "ARCHIVED" },
  { title: "Roma Sofa", status: "ACTIVE" },
  { title: "Vienna Draft Bed", status: "DRAFT" },
  { title: "Oslo Archived Table", status: "ARCHIVED" },
  { title: "Lisbon Hidden Lamp", status: "UNLISTED" },
  { title: "SuperMilano Stool", status: "ACTIVE" },
];

/**
 * Simulates Shopify's word-based search: every `title:word*` must prefix a
 * word of the title, and the product status must be in the `status:` list.
 * Without a status filter Shopify only returns ACTIVE products.
 */
function fakeShopify(catalog: P[], opts: { calls?: { query: string; after: string | null; token: string | null }[] } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url).toBe(`https://${SHOP}/admin/api/2026-07/graphql.json`);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { query: string; first: number; after: string | null };
    };
    opts.calls?.push({ query: body.variables.query, after: body.variables.after, token: headers.get("X-Shopify-Access-Token") });

    const q = body.variables.query;
    const words = [...q.matchAll(/title:([^\s*]+)\*/g)].map((m) => m[1]);
    const statusClause = /status:([a-z,]+)/.exec(q)?.[1];
    const statuses = statusClause ? statusClause.split(",").map((s) => s.toUpperCase()) : ["ACTIVE"];
    const hits = catalog
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => statuses.includes(p.status))
      .filter(({ p }) => {
        const tokens = p.title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
        return words.every((w) => tokens.some((t) => t.startsWith(w)));
      });
    const start = body.variables.after ? Number(body.variables.after) : 0;
    const page = hits.slice(start, start + body.variables.first);
    const next = start + page.length;
    return json({
      data: {
        products: {
          nodes: page.map(({ p, i }) => ({
            id: `gid://shopify/Product/${1000 + i}`,
            legacyResourceId: String(1000 + i),
            title: p.title,
            handle: p.title.toLowerCase().replace(/\s+/g, "-"),
            status: p.status,
            vendor: "BrandSure",
            productType: "Sofa",
            mediaCount: p.media === undefined ? null : { count: p.media, precision: "EXACT" },
          })),
          pageInfo: { hasNextPage: next < hits.length, endCursor: next < hits.length ? String(next) : null },
        },
      },
    });
  });
}

function deps(fetchImpl: typeof fetch, credsOverrides: Record<string, unknown> = {}) {
  const { repo, state } = fakeRepo();
  state.creds = {
    connectionId: "conn-1",
    workspaceId: WORKSPACE_ID,
    shopDomain: SHOP,
    connectionStatus: "connected",
    encryptedAccessToken: encryptToken(ACCESS, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "access")),
    encryptedRefreshToken: encryptToken(REFRESH, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "refresh")),
    tokenExpiresAt: new Date(NOW + 3_600_000),
    refreshTokenExpiresAt: new Date(NOW + 86_400_000),
    tokenVersion: 1,
    ...credsOverrides,
  };
  const d: ConnectionDeps = { config, repo, fetch: fetchImpl, now: () => NOW };
  return { deps: d, repo, state };
}

const titles = (r: { products: { title: string }[] }) => r.products.map((p) => p.title);

describe("buildProductSearchQuery", () => {
  it("prefix-searches each word and includes EVERY status", () => {
    expect(buildProductSearchQuery(" Milano  3 Seater ")).toBe(
      "title:milano* AND title:3* AND title:seater* AND status:active,archived,draft,unlisted",
    );
    expect(ALL_PRODUCT_STATUSES).toEqual(["active", "archived", "draft", "unlisted"]);
  });

  it("cannot inject search syntax (only letters/digits reach the query)", () => {
    const q = buildProductSearchQuery('Milano" OR status:active title:(x) -tag:y \\')!;
    expect(q).toBe(
      "title:milano* AND title:or* AND title:status* AND title:active* AND title:title* AND title:x* AND title:tag* AND title:y* AND status:active,archived,draft,unlisted",
    );
    expect(q).not.toMatch(/["()\\]/);
  });

  it("returns null when there is nothing searchable", () => {
    expect(buildProductSearchQuery("   ")).toBeNull();
    expect(buildProductSearchQuery("*** --- ")).toBeNull();
  });

  it("uses GraphQL Admin products with only safe fields", () => {
    expect(PRODUCT_SEARCH_QUERY).toContain("products(first: $first, after: $after, query: $query");
    expect(PRODUCT_SEARCH_QUERY).not.toMatch(/variants|sku|price|inventory/i);
  });
});

describe("searchProducts", () => {
  it("Case 1 — existing product: returns it", async () => {
    const { deps: d } = deps(fakeShopify(CATALOG));
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: "Roma" }, d);
    expect(r.products).toEqual([
      {
        id: "gid://shopify/Product/1003",
        legacyResourceId: "1003",
        title: "Roma Sofa",
        handle: "roma-sofa",
        status: "ACTIVE",
        vendor: "BrandSure",
        productType: "Sofa",
        mediaCount: null,
      },
    ]);
    expect(r.truncated).toBe(false);
  });

  it("Case 2 — unknown product: returns []", async () => {
    const { deps: d } = deps(fakeShopify(CATALOG));
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: "Stockholm" }, d);
    expect(r).toEqual({ products: [], truncated: false });
  });

  it("Case 3 — multiple products: returns all matches", async () => {
    const { deps: d } = deps(fakeShopify(CATALOG));
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: " milano " }, d);
    expect(titles(r)).toEqual(["Milano 3 Seater Sofa", "Milano Corner Sofa", "Milano Recliner"]);
    expect(r.products.map((p) => p.status)).toEqual(["ACTIVE", "DRAFT", "ARCHIVED"]);
    expect(r.products[0].mediaCount).toBe(4);
  });

  it("Case 4 — draft product: returned", async () => {
    const { deps: d } = deps(fakeShopify(CATALOG));
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: "Vienna" }, d);
    expect(r.products).toMatchObject([{ title: "Vienna Draft Bed", status: "DRAFT" }]);
  });

  it("Case 5 — archived product: returned (and unlisted too)", async () => {
    const { deps: d } = deps(fakeShopify(CATALOG));
    const archived = await searchProducts({ storeId: STORE_ID, searchTerm: "Oslo" }, d);
    expect(archived.products).toMatchObject([{ title: "Oslo Archived Table", status: "ARCHIVED" }]);
    const unlisted = await searchProducts({ storeId: STORE_ID, searchTerm: "Lisbon" }, d);
    expect(unlisted.products).toMatchObject([{ status: "UNLISTED" }]);
  });

  it("applies the exact contains rule after Shopify's broader word search", async () => {
    const calls: { query: string; after: string | null; token: string | null }[] = [];
    const { deps: d } = deps(fakeShopify(CATALOG, { calls }));
    // Shopify's word search finds "Milano 3 Seater Sofa" and "Milano Corner Sofa"
    // for sofa* AND milano*, but no title CONTAINS "sofa milano".
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: "Sofa Milano" }, d);
    expect(r.products).toEqual([]);
    // "SuperMilano Stool" is not a word-start match in Shopify search (documented limitation).
    const m = await searchProducts({ storeId: STORE_ID, searchTerm: "Milano" }, d);
    expect(titles(m)).not.toContain("SuperMilano Stool");
  });

  it("sends the access token only to the store's Shopify endpoint, never returns it", async () => {
    const calls: { query: string; after: string | null; token: string | null }[] = [];
    const { deps: d } = deps(fakeShopify(CATALOG, { calls }));
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: "Milano" }, d);
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe(ACCESS);
    const out = JSON.stringify(r);
    expect(out).not.toContain(ACCESS);
    expect(out).not.toContain(REFRESH);
    expect(out).not.toContain("v1.");
  });

  it("follows pagination and reports truncation", async () => {
    const many: P[] = Array.from({ length: 7 }, (_, i) => ({ title: `Milano ${i}`, status: "ACTIVE" }));
    const calls: { query: string; after: string | null; token: string | null }[] = [];
    const { deps: d } = deps(fakeShopify(many, { calls }));
    const all = await searchProducts({ storeId: STORE_ID, searchTerm: "Milano" }, d, { pageSize: 3 });
    expect(all.products).toHaveLength(7);
    expect(all.truncated).toBe(false);
    expect(calls.map((c) => c.after)).toEqual([null, "3", "6"]);

    const capped = await searchProducts({ storeId: STORE_ID, searchTerm: "Milano" }, d, { pageSize: 3, maxPages: 2 });
    expect(capped.products).toHaveLength(6);
    expect(capped.truncated).toBe(true);
  });

  it("empty term: no Shopify call", async () => {
    const f = fakeShopify(CATALOG);
    const { deps: d } = deps(f);
    expect(await searchProducts({ storeId: STORE_ID, searchTerm: " -- " }, d)).toEqual({ products: [], truncated: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("not connected → ShopifyFlowError not_connected, no Shopify call", async () => {
    const f = fakeShopify(CATALOG);
    const { deps: d, state } = deps(f);
    state.creds = null;
    await expect(searchProducts({ storeId: STORE_ID, searchTerm: "Milano" }, d)).rejects.toMatchObject({
      code: "not_connected",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("revoked token (401) → marks needs_reconnect and throws a friendly error", async () => {
    const f = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const { deps: d, repo } = deps(f as unknown as typeof fetch);
    const err = await searchProducts({ storeId: STORE_ID, searchTerm: "Milano" }, d).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyFlowError);
    expect(err.code).toBe("needs_reconnect");
    expect(repo.recordVerification).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE_ID, ok: false, failureStatus: "needs_reconnect" }),
    );
    expect(String(err.message)).not.toContain(ACCESS);
  });

  it("refreshes an expiring token first (reuses Prompt 4 token handling)", async () => {
    const graphql = fakeShopify(CATALOG);
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/admin/oauth/access_token")) {
        return json({
          access_token: "shpat_NEW_ACCESS",
          scope: "write_products,write_files",
          expires_in: 3600,
          refresh_token: "shprt_NEW_REFRESH",
          refresh_token_expires_in: 7_776_000,
        });
      }
      return graphql(input, init);
    });
    const { deps: d, repo } = deps(f as unknown as typeof fetch, { tokenExpiresAt: new Date(NOW + 60_000) });
    const r = await searchProducts({ storeId: STORE_ID, searchTerm: "Roma" }, d);
    expect(titles(r)).toEqual(["Roma Sofa"]);
    expect(repo.storeRefreshedTokens).toHaveBeenCalledTimes(1);
    const gqlHeaders = new Headers((graphql.mock.calls[0][1] as RequestInit).headers);
    expect(gqlHeaders.get("X-Shopify-Access-Token")).toBe("shpat_NEW_ACCESS");
  });
});
