import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encryptToken as encryptGoogle,
  googleTokenContext,
} from "@/lib/google/crypto";
import {
  encryptToken as encryptShopify,
  tokenContext,
} from "@/lib/shopify/crypto";
import {
  aboutOk,
  ACCESS as G_ACCESS,
  fakeGoogleRepo,
  G_NOW,
  G_STORE_ID,
  G_USER_ID,
  G_WORKSPACE_ID,
  googleConfig,
  googleFetch,
  json as gjson,
  REFRESH as G_REFRESH,
  tokenBody,
} from "./helpers/google-fakes";
import {
  config as shopifyConfig,
  fakeRepo,
  NOW,
  SHOP,
  shopifyFetch,
  STORE_ID,
  USER_ID,
  verifyResponse,
  WORKSPACE_ID,
} from "./helpers/shopify-fakes";

/**
 * Prompt 14C — permission matrix for the store integration server actions
 * (Shopify connect / verify / disconnect; Google Drive gaps not covered by
 * tests/google-security.test.ts: admin, signed-out verify/disconnect, member verify,
 * workspace scoping of the store lookup, error leakage). No network: fakes only.
 */

const OTHER_WS = "88888888-8888-4888-8888-888888888888";
const FOREIGN_STORE = "99999999-9999-4999-8999-999999999999"; // store in OTHER_WS
const MISSING_STORE = "77777777-7777-4777-8777-777777777777"; // exists nowhere
const S_ACCESS = "shpat_ACCESS_SECRET_ACTIONS";
const S_REFRESH = "shprt_REFRESH_SECRET_ACTIONS";
const DB_SECRET = "postgres://service_role:sb_secret_XYZ@db.internal";

type Role = "owner" | "admin" | "member";

const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  sessionExpired: false,
  storeQueries: [] as Record<string, unknown>[],
  shopifyDeps: null as unknown,
  googleDeps: null as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    // Same behaviour as the real helper: no session → /login (expired → ?reason=expired).
    requireWorkspace: vi.fn(async () => {
      const { redirect } = await import("next/navigation");
      if (mocks.sessionExpired) redirect("/login?reason=expired");
      if (!mocks.ctx) redirect("/login");
      return mocks.ctx;
    }),
  };
});
// RLS-scoped server client: records every filter so the tests can assert the lookup
// is always constrained to the CURRENT workspace (never the store id alone).
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const filters: Record<string, unknown> = { table };
      mocks.storeQueries.push(filters);
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return q;
        },
        async maybeSingle() {
          const rows = [
            { id: STORE_ID, workspace_id: WORKSPACE_ID, shopify_domain: SHOP },
            {
              id: G_STORE_ID,
              workspace_id: G_WORKSPACE_ID,
              shopify_domain: "brandsure.myshopify.com",
            },
            {
              id: FOREIGN_STORE,
              workspace_id: OTHER_WS,
              shopify_domain: "other.myshopify.com",
            },
          ];
          const row = rows.find(
            (r) =>
              r.id === filters.id && r.workspace_id === filters.workspace_id,
          );
          return {
            data: row
              ? { id: row.id, shopify_domain: row.shopify_domain }
              : null,
            error: null,
          };
        },
      };
      return q;
    },
  })),
}));
vi.mock("@/lib/shopify/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/runtime")>();
  return { ...actual, getShopifyDeps: vi.fn(() => mocks.shopifyDeps) };
});
vi.mock("@/lib/google/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/runtime")>();
  return { ...actual, getGoogleDeps: vi.fn(() => mocks.googleDeps) };
});

const shopify = await import("@/app/(app)/stores/[id]/shopify-actions");
const google = await import("@/app/(app)/stores/[id]/google-actions");

function ctxFor(workspaceId: string, role: Role, userId = USER_ID) {
  return {
    user: { id: userId, email: "u@example.com", fullName: "U" },
    memberships: [{ workspaceId, workspaceName: "WS", role }],
    workspace: { workspaceId, workspaceName: "WS", role },
  };
}

let logs: string[];
let s: ReturnType<typeof fakeRepo>;
let sFetch: ReturnType<typeof shopifyFetch>;
let g: ReturnType<typeof fakeGoogleRepo>;
let gFetch: ReturnType<typeof googleFetch>;

function shopifyCreds() {
  const key = shopifyConfig.tokenEncryptionKey;
  s.state.creds = {
    connectionId: "conn-1",
    workspaceId: WORKSPACE_ID,
    shopDomain: SHOP,
    connectionStatus: "connected",
    encryptedAccessToken: encryptShopify(
      S_ACCESS,
      key,
      tokenContext(STORE_ID, SHOP, "access"),
    ),
    encryptedRefreshToken: encryptShopify(
      S_REFRESH,
      key,
      tokenContext(STORE_ID, SHOP, "refresh"),
    ),
    tokenExpiresAt: new Date(NOW + 3_600_000),
    refreshTokenExpiresAt: new Date(NOW + 86_400_000),
    tokenVersion: 1,
  };
}

function googleCreds() {
  const key = googleConfig.tokenEncryptionKey;
  g.state.creds = {
    connectionId: "gconn-1",
    workspaceId: G_WORKSPACE_ID,
    googleAccountId: "google-sub-123",
    connectionStatus: "connected",
    encryptedAccessToken: encryptGoogle(
      G_ACCESS,
      key,
      googleTokenContext(G_STORE_ID, "access"),
    ),
    encryptedRefreshToken: encryptGoogle(
      G_REFRESH,
      key,
      googleTokenContext(G_STORE_ID, "refresh"),
    ),
    tokenExpiresAt: new Date(G_NOW + 3_600_000),
    tokenVersion: 1,
    accountShared: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ctx = null;
  mocks.sessionExpired = false;
  mocks.storeQueries = [];
  s = fakeRepo();
  sFetch = shopifyFetch({ graphql: () => verifyResponse() });
  mocks.shopifyDeps = {
    config: shopifyConfig,
    repo: s.repo,
    fetch: sFetch,
    now: () => NOW,
  };
  g = fakeGoogleRepo();
  gFetch = googleFetch({
    token: () => gjson(tokenBody()),
    drive: () => aboutOk(),
    revoke: () => new Response("", { status: 200 }),
  });
  mocks.googleDeps = {
    config: googleConfig,
    repo: g.repo,
    fetch: gFetch,
    now: () => G_NOW,
  };
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

const redirectOf = async (p: Promise<unknown>) => {
  const err = await p.then(() => null).catch((e) => e);
  return err ? String((err as { digest?: string }).digest ?? err) : null;
};
const leaks = (value: unknown, extra: string[] = []) => {
  const text = JSON.stringify(value) + "\n" + logs.join("\n");
  return [
    S_ACCESS,
    S_REFRESH,
    G_ACCESS,
    G_REFRESH,
    DB_SECRET,
    "sb_secret_",
    shopifyConfig.clientSecret,
    "v1.",
    ...extra,
  ].filter((x) => text.includes(x));
};

// ---------------------------------------------------------------------------
describe("Shopify store actions — permission matrix", () => {
  it.each(["owner", "admin"] as const)(
    "%s: Connect starts OAuth for THIS store and redirects to Shopify",
    async (role) => {
      mocks.ctx = ctxFor(WORKSPACE_ID, role);
      const target = await redirectOf(shopify.connectShopify(STORE_ID));
      expect(target).toContain("NEXT_REDIRECT");
      expect(target).toContain(`https://${SHOP}/admin/oauth/authorize`);
      expect(s.repo.beginOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, storeId: STORE_ID }),
      );
      // the redirect carries only the public client id + state, never the secret
      expect(target).not.toContain(shopifyConfig.clientSecret);
    },
  );

  it.each(["owner", "admin"] as const)(
    "%s: Verify and Disconnect are allowed",
    async (role) => {
      mocks.ctx = ctxFor(WORKSPACE_ID, role);
      shopifyCreds();
      const verified = await shopify.verifyShopify(STORE_ID);
      expect(verified).toEqual({
        ok: true,
        message: "Connected to Royal Sofa. Everything looks good.",
      });
      sFetch.mockClear();
      const disconnected = await shopify.disconnectShopify(STORE_ID);
      expect(disconnected).toEqual({
        ok: true,
        message: "Shopify disconnected. Your sync history was kept.",
      });
      expect(s.repo.disconnect).toHaveBeenCalledWith(STORE_ID, USER_ID);
      expect(leaks([verified, disconnected])).toEqual([]);
    },
  );

  it("member: Connect / Verify / Disconnect are refused before any Shopify or DB call", async () => {
    mocks.ctx = ctxFor(WORKSPACE_ID, "member");
    shopifyCreds();
    const msg = {
      error:
        "Only workspace owners and admins can manage the Shopify connection.",
    };
    expect(await shopify.connectShopify(STORE_ID)).toEqual(msg);
    expect(await shopify.verifyShopify(STORE_ID)).toEqual(msg);
    expect(await shopify.disconnectShopify(STORE_ID)).toEqual(msg);
    expect(s.repo.beginOAuth).not.toHaveBeenCalled();
    expect(s.repo.getCredentials).not.toHaveBeenCalled();
    expect(s.repo.disconnect).not.toHaveBeenCalled();
    expect(sFetch).not.toHaveBeenCalled();
    expect(mocks.storeQueries).toHaveLength(0); // refused before the store lookup
  });

  it.each([
    ["signed out", false, "/login"],
    ["session expired", true, "/login?reason=expired"],
  ])(
    "%s: every action redirects to login and does nothing",
    async (_label, expired, path) => {
      mocks.sessionExpired = expired;
      for (const run of [
        shopify.connectShopify,
        shopify.verifyShopify,
        shopify.disconnectShopify,
      ]) {
        const target = await redirectOf(run(STORE_ID));
        expect(target).toContain("NEXT_REDIRECT");
        expect(target).toContain(path);
      }
      expect(s.repo.beginOAuth).not.toHaveBeenCalled();
      expect(s.repo.getCredentials).not.toHaveBeenCalled();
      expect(s.repo.disconnect).not.toHaveBeenCalled();
      expect(sFetch).not.toHaveBeenCalled();
    },
  );

  it("owner of ANOTHER workspace cannot operate on this store (not found, nothing touched)", async () => {
    mocks.ctx = ctxFor(
      OTHER_WS,
      "owner",
      "abababab-abab-4bab-8bab-abababababab",
    );
    shopifyCreds();
    for (const run of [
      shopify.connectShopify,
      shopify.verifyShopify,
      shopify.disconnectShopify,
    ]) {
      expect(await run(STORE_ID)).toEqual({
        error: "We couldn't find this store in your workspace.",
      });
    }
    expect(s.repo.beginOAuth).not.toHaveBeenCalled();
    expect(s.repo.getCredentials).not.toHaveBeenCalled();
    expect(s.repo.disconnect).not.toHaveBeenCalled();
    expect(sFetch).not.toHaveBeenCalled();
  });

  it("forged store id (a store of another workspace, or one that doesn't exist) → same not-found answer", async () => {
    mocks.ctx = ctxFor(WORKSPACE_ID, "owner");
    for (const id of [FOREIGN_STORE, MISSING_STORE]) {
      for (const run of [
        shopify.connectShopify,
        shopify.verifyShopify,
        shopify.disconnectShopify,
      ]) {
        expect(await run(id)).toEqual({
          error: "We couldn't find this store in your workspace.",
        });
      }
    }
    for (const bad of ["not-a-uuid", "", "' or 1=1 --", `${STORE_ID}/../x`]) {
      expect(await shopify.connectShopify(bad)).toEqual({
        error: "You do not have access to this workspace.",
      });
    }
    expect(s.repo.beginOAuth).not.toHaveBeenCalled();
    expect(s.repo.disconnect).not.toHaveBeenCalled();
    expect(sFetch).not.toHaveBeenCalled();
  });

  it("the store is always resolved against the CURRENT workspace (id AND workspace_id filter)", async () => {
    mocks.ctx = ctxFor(WORKSPACE_ID, "owner");
    shopifyCreds();
    await redirectOf(shopify.connectShopify(STORE_ID));
    await shopify.verifyShopify(STORE_ID);
    await shopify.disconnectShopify(STORE_ID);
    expect(mocks.storeQueries).toHaveLength(3);
    for (const q of mocks.storeQueries)
      expect(q).toEqual({
        table: "stores",
        id: STORE_ID,
        workspace_id: WORKSPACE_ID,
      });
  });

  it("failures return friendly messages only — no tokens, DB errors or secrets", async () => {
    mocks.ctx = ctxFor(WORKSPACE_ID, "owner");
    s.repo.beginOAuth = vi.fn(async () => {
      throw new Error(`insert failed: ${DB_SECRET} ${S_ACCESS}`);
    });
    const started = await shopify.connectShopify(STORE_ID);
    shopifyCreds();
    s.repo.getCredentials = vi.fn(async () => {
      throw new Error(`select failed: ${DB_SECRET}`);
    });
    const verified = await shopify.verifyShopify(STORE_ID);
    s.repo.disconnect = vi.fn(async () => {
      throw new Error(`delete failed: ${DB_SECRET} ${S_REFRESH}`);
    });
    const disconnected = await shopify.disconnectShopify(STORE_ID);
    for (const r of [started, verified, disconnected])
      expect(r).toMatchObject({ error: expect.any(String) });
    expect(leaks([started, verified, disconnected])).toEqual([]);
  });

  it("Shopify answering 401 during Verify → friendly reconnect message, token never echoed", async () => {
    mocks.ctx = ctxFor(WORKSPACE_ID, "admin");
    shopifyCreds();
    sFetch = shopifyFetch({
      graphql: () =>
        gjson(
          {
            errors: `[API] Invalid API key or access token (unrecognized login or wrong password) ${S_ACCESS}`,
          },
          401,
        ),
    });
    mocks.shopifyDeps = {
      config: shopifyConfig,
      repo: s.repo,
      fetch: sFetch,
      now: () => NOW,
    };
    const r = await shopify.verifyShopify(STORE_ID);
    expect(r).toMatchObject({ error: expect.stringMatching(/reconnect/i) });
    expect(leaks(r)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("Google Drive store actions — gaps not covered by google-security.test.ts", () => {
  it("admin: Connect / Verify / Disconnect are allowed", async () => {
    mocks.ctx = ctxFor(G_WORKSPACE_ID, "admin", G_USER_ID);
    const target = await redirectOf(google.connectGoogleDrive(G_STORE_ID));
    expect(target).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(g.state.begun[0]).toMatchObject({
      userId: G_USER_ID,
      storeId: G_STORE_ID,
    });
    googleCreds();
    expect(await google.verifyGoogleDrive(G_STORE_ID)).toMatchObject({
      ok: true,
    });
    expect(await google.disconnectGoogleDrive(G_STORE_ID)).toEqual({
      ok: true,
      message: "Google Drive disconnected. Your sync history was kept.",
    });
  });

  it("member: Verify (and every other Drive action) is refused before touching credentials", async () => {
    mocks.ctx = ctxFor(G_WORKSPACE_ID, "member", G_USER_ID);
    googleCreds();
    const msg = {
      error:
        "Only workspace owners and admins can manage the Google Drive connection.",
    };
    expect(await google.verifyGoogleDrive(G_STORE_ID)).toEqual(msg);
    expect(
      await google.selectGoogleRootFolder(G_STORE_ID, "folderIdAbcdefgh1"),
    ).toMatchObject(msg);
    expect(
      await google.addGoogleCategoryRoot(G_STORE_ID, "folderIdAbcdefgh1"),
    ).toMatchObject(msg);
    expect(
      await google.removeGoogleCategoryRoot(G_STORE_ID, "folderIdAbcdefgh1"),
    ).toMatchObject(msg);
    expect(g.repo.getCredentials).not.toHaveBeenCalled();
    expect(gFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["signed out", false, "/login"],
    ["session expired", true, "/login?reason=expired"],
  ])(
    "%s: Verify and Disconnect redirect to login and do nothing",
    async (_label, expired, path) => {
      mocks.sessionExpired = expired;
      for (const run of [
        google.verifyGoogleDrive,
        google.disconnectGoogleDrive,
      ]) {
        expect(await redirectOf(run(G_STORE_ID))).toContain(path);
      }
      expect(g.repo.getCredentials).not.toHaveBeenCalled();
      expect(g.repo.disconnect).not.toHaveBeenCalled();
      expect(gFetch).not.toHaveBeenCalled();
    },
  );

  it("owner of another workspace / forged store ids → not found for every Drive action", async () => {
    mocks.ctx = ctxFor(
      OTHER_WS,
      "owner",
      "abababab-abab-4bab-8bab-abababababab",
    );
    expect(await google.verifyGoogleDrive(G_STORE_ID)).toEqual({
      error: "We couldn't find this store in your workspace.",
    });
    mocks.ctx = ctxFor(G_WORKSPACE_ID, "owner", G_USER_ID);
    for (const id of [FOREIGN_STORE, MISSING_STORE]) {
      for (const run of [
        (x: string) => google.selectGoogleRootFolder(x, "folderIdAbcdefgh1"),
        (x: string) => google.addGoogleCategoryRoot(x, "folderIdAbcdefgh1"),
        (x: string) => google.removeGoogleCategoryRoot(x, "folderIdAbcdefgh1"),
      ]) {
        expect(await run(id)).toMatchObject({
          error: "We couldn't find this store in your workspace.",
        });
      }
    }
    expect(g.repo.getCredentials).not.toHaveBeenCalled();
    expect(gFetch).not.toHaveBeenCalled();
  });

  it("the Drive store lookup is always scoped to the current workspace", async () => {
    mocks.ctx = ctxFor(G_WORKSPACE_ID, "owner", G_USER_ID);
    googleCreds();
    await google.verifyGoogleDrive(G_STORE_ID);
    await google.disconnectGoogleDrive(G_STORE_ID);
    expect(mocks.storeQueries.filter((q) => q.table === "stores")).toEqual([
      { table: "stores", id: G_STORE_ID, workspace_id: G_WORKSPACE_ID },
      { table: "stores", id: G_STORE_ID, workspace_id: G_WORKSPACE_ID },
    ]);
  });

  it("Drive failures return friendly messages only — no tokens, DB errors or secrets", async () => {
    mocks.ctx = ctxFor(G_WORKSPACE_ID, "owner", G_USER_ID);
    g.repo.beginOAuth = vi.fn(async () => {
      throw new Error(`insert failed: ${DB_SECRET}`);
    });
    const started = await google.connectGoogleDrive(G_STORE_ID);
    googleCreds();
    g.repo.getCredentials = vi.fn(async () => {
      throw new Error(`select failed: ${DB_SECRET} ${G_REFRESH}`);
    });
    const verified = await google.verifyGoogleDrive(G_STORE_ID);
    g.repo.disconnect = vi.fn(async () => {
      throw new Error(`delete failed: ${DB_SECRET}`);
    });
    const disconnected = await google.disconnectGoogleDrive(G_STORE_ID);
    for (const r of [started, verified, disconnected])
      expect(r).toMatchObject({ error: expect.any(String) });
    expect(
      leaks([started, verified, disconnected], [googleConfig.clientSecret]),
    ).toEqual([]);
  });
});
