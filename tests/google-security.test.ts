import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptToken, googleTokenContext } from "@/lib/google/crypto";
import {
  aboutOk,
  ACCESS,
  fakeGoogleRepo,
  G_NOW,
  G_STORE_ID,
  G_USER_ID,
  G_WORKSPACE_ID,
  googleConfig,
  googleFetch,
  json,
  REFRESH,
  tokenBody,
} from "./helpers/google-fakes";

/**
 * Security tests for GET /api/google/callback and the Google Drive server
 * actions (connect / verify / disconnect).
 */

const OTHER_WS = "88888888-8888-4888-8888-888888888888";
/** The configured public URL (ngrok) — what users actually browse. */
const SITE = "https://reach-rental-heat.ngrok-free.dev";
const OTHER_STORE = "99999999-9999-4999-8999-999999999999";

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string } | null,
  ctx: null as unknown,
  deps: null as unknown,
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn(async () => mocks.sessionUser) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    requireWorkspace: vi.fn(async () => {
      if (!mocks.ctx) {
        // Same behaviour as the real helper: redirect to login.
        const { redirect } = await import("next/navigation");
        redirect("/login");
      }
      return mocks.ctx;
    }),
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from() {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return q;
        },
        async maybeSingle() {
          const rows = [
            { id: G_STORE_ID, workspace_id: G_WORKSPACE_ID, shopify_domain: "brandsure.myshopify.com" },
            { id: OTHER_STORE, workspace_id: OTHER_WS, shopify_domain: "other.myshopify.com" },
          ];
          const row = rows.find((r) => r.id === filters.id && r.workspace_id === filters.workspace_id);
          return { data: row ? { id: row.id, shopify_domain: row.shopify_domain } : null, error: null };
        },
      };
      return q;
    },
  })),
}));
vi.mock("@/lib/google/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/runtime")>();
  return { ...actual, getGoogleDeps: vi.fn(() => mocks.deps) };
});

const { GET } = await import("@/app/api/google/callback/route");
const actions = await import("@/app/(app)/stores/[id]/google-actions");

let fetchMock: ReturnType<typeof googleFetch>;
let repoBundle: ReturnType<typeof fakeGoogleRepo>;

function ctx(role: "owner" | "admin" | "member") {
  return {
    user: { id: G_USER_ID, email: "owner@example.com", fullName: "Owner" },
    memberships: [{ workspaceId: G_WORKSPACE_ID, workspaceName: "A", role }],
    workspace: { workspaceId: G_WORKSPACE_ID, workspaceName: "A", role },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  vi.stubEnv("GOOGLE_REDIRECT_URI", `${SITE}/api/google/callback`);
  mocks.sessionUser = { id: G_USER_ID };
  mocks.ctx = ctx("owner");
  fetchMock = googleFetch({ token: () => json(tokenBody()), drive: () => aboutOk(), revoke: () => new Response("", { status: 200 }) });
  repoBundle = fakeGoogleRepo();
  mocks.deps = { config: googleConfig, repo: repoBundle.repo, fetch: fetchMock, now: () => G_NOW };
});

const callback = (params: Record<string, string>) =>
  GET(
    // Behind ngrok, Next's dev server builds request.url as https://localhost:3000/… (its own
    // host + X-Forwarded-Proto). The redirect must NOT be derived from it.
    new NextRequest(`https://localhost:3000/api/google/callback?${new URLSearchParams(params)}`, {
      headers: { host: "reach-rental-heat.ngrok-free.dev", "x-forwarded-proto": "https" },
    }),
  );

describe("GET /api/google/callback", () => {
  it("success → store page, no code or tokens in the redirect", async () => {
    const res = await callback({ code: "SECRET-AUTH-CODE", state: "abc", scope: "x" });
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toBe(`${SITE}/stores/${G_STORE_ID}?google=connected`);
    expect(location).not.toContain("SECRET-AUTH-CODE");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await res.text();
    for (const secret of [ACCESS, REFRESH, googleConfig.clientSecret]) {
      expect(body).not.toContain(secret);
      expect(location).not.toContain(secret);
    }
  });

  it("REGRESSION: success redirects to the configured site URL, never https://localhost:3000", async () => {
    const res = await callback({ code: "c", state: "abc" });
    const location = res.headers.get("location")!;
    expect(location).toBe(`https://reach-rental-heat.ngrok-free.dev/stores/${G_STORE_ID}?google=connected`);
    expect(location).not.toContain("https://localhost");
    expect(location).not.toContain("localhost:3000");
  });

  it("forged Host / X-Forwarded-Host headers can't change the redirect target (no open redirect)", async () => {
    const res = await GET(
      new NextRequest("https://evil.example.com/api/google/callback?code=c&state=abc", {
        headers: { host: "evil.example.com", "x-forwarded-host": "evil.example.com", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.headers.get("location")).toBe(`${SITE}/stores/${G_STORE_ID}?google=connected`);
  });

  it("no NEXT_PUBLIC_SITE_URL → falls back to GOOGLE_REDIRECT_URI's origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const res = await callback({ code: "c", state: "abc" });
    expect(res.headers.get("location")).toBe(`${SITE}/stores/${G_STORE_ID}?google=connected`);
  });

  it("direct local testing: http://localhost:3000 (never https://localhost)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    vi.stubEnv("GOOGLE_REDIRECT_URI", "http://localhost:3000/api/google/callback");
    const res = await callback({ code: "c", state: "abc" });
    expect(res.headers.get("location")).toBe(`http://localhost:3000/stores/${G_STORE_ID}?google=connected`);
  });

  it("unauthenticated (signed-out browser) → session_mismatch, no token exchange", async () => {
    mocks.sessionUser = null;
    const res = await callback({ code: "c", state: "abc" });
    expect(res.headers.get("location")).toBe(`${SITE}/stores/${G_STORE_ID}?google_error=session_mismatch`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(repoBundle.repo.saveConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", "invalid_state"],
    ["reused", "reused_state"],
    ["expired", "expired_state"],
  ] as const)("%s state → /stores?google_error=%s", async (status, code) => {
    repoBundle.state.consumed = { status };
    const res = await callback({ code: "c", state: "abc" });
    expect(res.headers.get("location")).toBe(`${SITE}/stores?google_error=${code}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("OAuth state cannot be reused: second callback with the same state is rejected", async () => {
    let used = false;
    vi.mocked(repoBundle.repo.consumeState).mockImplementation(async () => {
      if (used) return { status: "reused" };
      used = true;
      return { status: "ok", userId: G_USER_ID, workspaceId: G_WORKSPACE_ID, storeId: G_STORE_ID };
    });
    expect((await callback({ code: "c", state: "same" })).headers.get("location")).toContain("google=connected");
    expect((await callback({ code: "c", state: "same" })).headers.get("location")).toContain("google_error=reused_state");
    expect(repoBundle.repo.saveConnection).toHaveBeenCalledTimes(1);
  });

  it("Google not configured → friendly error code, variable names only in logs", async () => {
    const { GoogleFlowError } = await import("@/lib/google/errors");
    const runtime = await import("@/lib/google/runtime");
    vi.mocked(runtime.getGoogleDeps).mockImplementationOnce(() => {
      throw new GoogleFlowError("not_configured");
    });
    const res = await callback({ code: "c", state: "abc" });
    expect(res.headers.get("location")).toBe(`${SITE}/stores?google_error=not_configured`);
  });
});

describe("Google Drive server actions", () => {
  it("owner: Connect redirects to Google (state stored for THIS store)", async () => {
    const err = await actions.connectGoogleDrive(G_STORE_ID).catch((e) => e);
    expect(String(err?.digest ?? err)).toContain("NEXT_REDIRECT");
    expect(String(err.digest)).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(repoBundle.state.begun[0]).toMatchObject({ userId: G_USER_ID, storeId: G_STORE_ID });
  });

  it("unauthenticated → sent to login, nothing started", async () => {
    mocks.ctx = null;
    const err = await actions.connectGoogleDrive(G_STORE_ID).catch((e) => e);
    expect(String(err.digest)).toContain("/login");
    expect(repoBundle.repo.beginOAuth).not.toHaveBeenCalled();
  });

  it("member role → refused, nothing started", async () => {
    mocks.ctx = ctx("member");
    expect(await actions.connectGoogleDrive(G_STORE_ID)).toEqual({
      error: "Only workspace owners and admins can manage the Google Drive connection.",
    });
    expect(await actions.disconnectGoogleDrive(G_STORE_ID)).toMatchObject({ error: expect.any(String) });
    expect(repoBundle.repo.beginOAuth).not.toHaveBeenCalled();
    expect(repoBundle.repo.disconnect).not.toHaveBeenCalled();
  });

  it("store of another workspace → not found; cannot connect, verify or disconnect it", async () => {
    for (const run of [actions.connectGoogleDrive, actions.verifyGoogleDrive, actions.disconnectGoogleDrive]) {
      expect(await run(OTHER_STORE)).toEqual({ error: "We couldn't find this store in your workspace." });
    }
    expect(repoBundle.repo.beginOAuth).not.toHaveBeenCalled();
    expect(repoBundle.repo.getCredentials).not.toHaveBeenCalled();
    expect(repoBundle.repo.disconnect).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid store id → refused", async () => {
    expect(await actions.connectGoogleDrive("not-a-uuid")).toMatchObject({ error: expect.any(String) });
  });

  it("verify / disconnect responses never contain tokens", async () => {
    const key = googleConfig.tokenEncryptionKey;
    repoBundle.state.creds = {
      connectionId: "gconn-1",
      workspaceId: G_WORKSPACE_ID,
      googleAccountId: "google-sub-123",
      connectionStatus: "connected",
      encryptedAccessToken: encryptToken(ACCESS, key, googleTokenContext(G_STORE_ID, "access")),
      encryptedRefreshToken: encryptToken(REFRESH, key, googleTokenContext(G_STORE_ID, "refresh")),
      tokenExpiresAt: new Date(G_NOW + 3_600_000),
      tokenVersion: 1,
      accountShared: false,
    };
    const verified = await actions.verifyGoogleDrive(G_STORE_ID);
    expect(verified).toEqual({ ok: true, message: "Google Drive is connected (owner@gmail.com). Everything looks good." });
    const disconnected = await actions.disconnectGoogleDrive(G_STORE_ID);
    expect(disconnected).toEqual({ ok: true, message: "Google Drive disconnected. Your sync history was kept." });
    const out = JSON.stringify([verified, disconnected]);
    for (const secret of [ACCESS, REFRESH, "v1."]) expect(out).not.toContain(secret);
  });
});
