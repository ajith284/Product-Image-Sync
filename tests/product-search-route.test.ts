import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptToken, tokenContext } from "@/lib/shopify/crypto";
import { isJsonApiPath, isPublicPath } from "@/lib/routes";
import { config, fakeRepo, json, NOW } from "./helpers/shopify-fakes";

/**
 * Security tests for POST /api/shopify/products/search.
 * Two workspaces: user A (workspace A, store A connected) and a store B in
 * workspace B that user A must never reach.
 */

const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const STORE_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const STORE_A_NOT_CONNECTED = "aaaaaaaa-0000-4000-8000-0000000000a2";
const STORE_A_RECONNECT = "aaaaaaaa-0000-4000-8000-0000000000a3";
const STORE_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const SHOP_A = "brandsure-test.myshopify.com";
const ACCESS = "shpat_ROUTE_ACCESS_SECRET";
const REFRESH = "shprt_ROUTE_REFRESH_SECRET";

const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  ctxError: null as Error | null,
  deps: null as unknown,
}));

vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    loadWorkspaceContext: vi.fn(async () => {
      if (mocks.ctxError) throw mocks.ctxError;
      return mocks.ctx;
    }),
  };
});

/** Tiny Supabase stand-in with RLS: user A only sees rows of workspace A. */
const TABLES: Record<string, Record<string, unknown>[]> = {
  stores: [
    { id: STORE_A, workspace_id: WS_A },
    { id: STORE_A_NOT_CONNECTED, workspace_id: WS_A },
    { id: STORE_A_RECONNECT, workspace_id: WS_A },
    { id: STORE_B, workspace_id: WS_B },
  ],
  shopify_connections: [
    { store_id: STORE_A, workspace_id: WS_A, connection_status: "connected" },
    { store_id: STORE_A_RECONNECT, workspace_id: WS_A, connection_status: "needs_reconnect" },
    { store_id: STORE_B, workspace_id: WS_B, connection_status: "connected" },
  ],
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const filters: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        async maybeSingle() {
          const rows = (TABLES[table] ?? [])
            .filter((r) => r.workspace_id === WS_A) // RLS for user A
            .filter((r) => filters.every(([c, v]) => r[c] === v));
          return { data: rows[0] ?? null, error: null };
        },
      };
      return q;
    },
  })),
}));

vi.mock("@/lib/shopify/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/runtime")>();
  return { ...actual, getShopifyDeps: vi.fn(() => mocks.deps) };
});

const { POST } = await import("@/app/api/shopify/products/search/route");
const { SessionExpiredError } = await import("@/lib/workspace");

function shopifyFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(`https://${SHOP_A}/admin/api/2026-07/graphql.json`)) throw new Error(`unexpected ${url}`);
    const { variables } = JSON.parse(String(init?.body));
    const all = [
      { title: "Milano 3 Seater Sofa", status: "ACTIVE" },
      { title: "Milano Sofa", status: "DRAFT" },
      { title: "Milano Recliner", status: "ARCHIVED" },
    ];
    const nodes = variables.query.includes("title:milano*")
      ? all.map((p, i) => ({
          id: `gid://shopify/Product/${i + 1}`,
          legacyResourceId: String(i + 1),
          handle: `h-${i}`,
          vendor: "BrandSure",
          productType: "Sofa",
          mediaCount: { count: i, precision: "EXACT" },
          ...p,
        }))
      : [];
    return json({ data: { products: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  });
}

let fetchMock: ReturnType<typeof shopifyFetch>;
let logs: string[];

beforeEach(() => {
  mocks.ctxError = null;
  mocks.ctx = {
    user: { id: USER_A, email: "a@example.com", fullName: "A" },
    memberships: [{ workspaceId: WS_A, workspaceName: "A", role: "member" }],
    workspace: { workspaceId: WS_A, workspaceName: "A", role: "member" },
  };
  const { repo, state } = fakeRepo();
  state.creds = {
    connectionId: "conn-a",
    workspaceId: WS_A,
    shopDomain: SHOP_A,
    connectionStatus: "connected",
    encryptedAccessToken: encryptToken(ACCESS, config.tokenEncryptionKey, tokenContext(STORE_A, SHOP_A, "access")),
    encryptedRefreshToken: encryptToken(REFRESH, config.tokenEncryptionKey, tokenContext(STORE_A, SHOP_A, "refresh")),
    tokenExpiresAt: new Date(NOW + 3_600_000),
    refreshTokenExpiresAt: new Date(NOW + 86_400_000),
    tokenVersion: 1,
  };
  fetchMock = shopifyFetch();
  mocks.deps = { config, repo, fetch: fetchMock, now: () => NOW };

  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => vi.restoreAllMocks());

function post(body: unknown, contentType = "application/json") {
  return POST(
    new NextRequest("http://localhost:3000/api/shopify/products/search", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/shopify/products/search", () => {
  it("returns all matches with safe fields only (any role, incl. member)", async () => {
    const res = await post({ storeId: STORE_A, searchTerm: "Milano" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.matchStatus).toBe("multiple_matches");
    expect(body.count).toBe(3);
    expect(body.products.map((p: { status: string }) => p.status)).toEqual(["ACTIVE", "DRAFT", "ARCHIVED"]);
    expect(Object.keys(body.products[0]).sort()).toEqual(
      ["handle", "id", "legacyResourceId", "mediaCount", "productType", "status", "title", "vendor"].sort(),
    );
  });

  it("no match → empty list", async () => {
    const body = await (await post({ storeId: STORE_A, searchTerm: "Oslo" })).json();
    expect(body).toMatchObject({ matchStatus: "no_product_found", count: 0, products: [] });
  });

  it("unauthenticated → 401, nothing searched", async () => {
    mocks.ctx = null;
    const res = await post({ storeId: STORE_A, searchTerm: "Milano" });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expired session → 401", async () => {
    mocks.ctxError = new SessionExpiredError();
    expect((await post({ storeId: STORE_A, searchTerm: "Milano" })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no workspace membership → 403", async () => {
    mocks.ctx = { user: { id: USER_A }, memberships: [], workspace: null };
    expect((await post({ storeId: STORE_A, searchTerm: "Milano" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("workspace A user → workspace B store: 404, Shopify never called", async () => {
    const res = await post({ storeId: STORE_B, searchTerm: "Milano" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "We couldn't find this store in your workspace." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((mocks.deps as { repo: { getCredentials: unknown } }).repo.getCredentials).not.toHaveBeenCalled();
  });

  it("store in the user's OTHER workspace (not the current one) → 404", async () => {
    // User A is also a member of B, but B is not the selected workspace.
    const ctx = mocks.ctx as { memberships: unknown[] };
    ctx.memberships.push({ workspaceId: WS_B, workspaceName: "B", role: "owner" });
    expect((await post({ storeId: STORE_B, searchTerm: "Milano" })).status).toBe(404);
  });

  it("invalid store id → 404 (same answer, no enumeration)", async () => {
    expect((await post({ storeId: "not-a-uuid", searchTerm: "Milano" })).status).toBe(404);
  });

  it("Shopify not connected → 409 friendly message", async () => {
    const res = await post({ storeId: STORE_A_NOT_CONNECTED, searchTerm: "Milano" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Shopify isn't connected for this store.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connection needs reconnect → 409", async () => {
    const res = await post({ storeId: STORE_A_RECONNECT, searchTerm: "Milano" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Shopify needs to be reconnected.");
  });

  it("validates input", async () => {
    expect((await post({ storeId: STORE_A, searchTerm: "   " })).status).toBe(400);
    expect((await post({ storeId: STORE_A, searchTerm: "x".repeat(121) })).status).toBe(400);
    expect((await post({ storeId: STORE_A })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
  });

  it("rejects non-JSON (plain form) posts → 415", async () => {
    expect((await post("storeId=x&searchTerm=y", "application/x-www-form-urlencoded")).status).toBe(415);
  });

  it("tokens never appear in responses or logs (success and failure)", async () => {
    const ok = await (await post({ storeId: STORE_A, searchTerm: "Milano" })).text();

    // Failure path: Shopify rejects the token.
    fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    const failed = await post({ storeId: STORE_A, searchTerm: "Milano" });
    expect(failed.status).toBe(409);
    const failedText = await failed.text();
    expect(JSON.parse(failedText)).toEqual({ error: "Shopify needs to be reconnected." });

    for (const text of [ok, failedText, ...logs]) {
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain(config.clientSecret);
      expect(text).not.toMatch(/v1\.[A-Za-z0-9_-]+\./); // encrypted token format
    }
    expect(logs.join("\n")).toContain("[shopify] product-search: needs_reconnect");
  });
});

describe("proxy routing for the search API", () => {
  it("is a JSON API path (signed-out → 401 JSON, not a login redirect) and not public", () => {
    expect(isJsonApiPath("/api/shopify/products/search")).toBe(true);
    expect(isPublicPath("/api/shopify/products/search")).toBe(false);
    expect(isJsonApiPath("/api/shopify/callback")).toBe(false);
  });
});
