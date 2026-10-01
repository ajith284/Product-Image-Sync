import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isJsonApiPath, isPublicPath } from "@/lib/routes";
import { ACCESS, G_STORE_ID, G_USER_ID, G_WORKSPACE_ID, googleConfig, REFRESH } from "./helpers/google-fakes";
import { driveDeps, driveTree, fakeDriveFetch } from "./helpers/fake-drive";

/**
 * Security tests for POST /api/google/folders and the selectGoogleRootFolder action.
 * Workspace A owns store G_STORE_ID (Drive connected). Workspace B owns OTHER_STORE.
 */
const OTHER_WS = "88888888-8888-4888-8888-888888888888";
const OTHER_STORE = "99999999-9999-4999-8999-999999999999";
const NOT_CONNECTED_STORE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const RECONNECT_STORE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  ctxError: null as Error | null,
  deps: null as unknown,
  settings: { ignored_folders: ["OG"], allowed_image_types: ["jpg", "jpeg", "png", "webp"] } as Record<string, unknown>,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    loadWorkspaceContext: vi.fn(async () => {
      if (mocks.ctxError) throw mocks.ctxError;
      return mocks.ctx;
    }),
    requireWorkspace: vi.fn(async () => {
      if (!mocks.ctx) {
        const { redirect } = await import("next/navigation");
        redirect("/login");
      }
      return mocks.ctx;
    }),
  };
});

/** Supabase stand-in with RLS: the signed-in user only sees workspace A's rows. */
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return q;
        },
        async maybeSingle() {
          const tables: Record<string, Record<string, unknown>[]> = {
            stores: [
              { id: G_STORE_ID, workspace_id: G_WORKSPACE_ID, shopify_domain: "brandsure.myshopify.com" },
              { id: NOT_CONNECTED_STORE, workspace_id: G_WORKSPACE_ID, shopify_domain: null },
              { id: RECONNECT_STORE, workspace_id: G_WORKSPACE_ID, shopify_domain: null },
              { id: OTHER_STORE, workspace_id: OTHER_WS, shopify_domain: null },
            ],
            google_drive_connections: [
              { store_id: G_STORE_ID, workspace_id: G_WORKSPACE_ID, connection_status: "connected" },
              { store_id: RECONNECT_STORE, workspace_id: G_WORKSPACE_ID, connection_status: "needs_reconnect" },
              { store_id: OTHER_STORE, workspace_id: OTHER_WS, connection_status: "connected" },
            ],
            store_settings: [{ store_id: G_STORE_ID, workspace_id: G_WORKSPACE_ID, ...mocks.settings }],
          };
          const row = (tables[table] ?? [])
            .filter((r) => r.workspace_id === G_WORKSPACE_ID) // RLS
            .find((r) => Object.entries(filters).every(([c, v]) => r[c] === v));
          return { data: row ?? null, error: null };
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

const { POST } = await import("@/app/api/google/folders/route");
const actions = await import("@/app/(app)/stores/[id]/google-actions");
const { SessionExpiredError } = await import("@/lib/workspace");

let fetchMock: ReturnType<typeof fakeDriveFetch>;
let bundle: ReturnType<typeof driveDeps>;
let logs: string[];

function ctx(role: "owner" | "admin" | "member") {
  return {
    user: { id: G_USER_ID, email: "owner@example.com", fullName: "Owner" },
    memberships: [{ workspaceId: G_WORKSPACE_ID, workspaceName: "A", role }],
    workspace: { workspaceId: G_WORKSPACE_ID, workspaceName: "A", role },
  };
}

beforeEach(() => {
  mocks.ctx = ctx("owner");
  mocks.ctxError = null;
  mocks.settings = { ignored_folders: ["OG"], allowed_image_types: ["jpg", "jpeg", "png", "webp"] };
  fetchMock = fakeDriveFetch();
  bundle = driveDeps(fetchMock);
  mocks.deps = bundle.deps;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

const post = (body: unknown, contentType = "application/json") =>
  POST(
    new NextRequest("http://localhost:3000/api/google/folders", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

describe("POST /api/google/folders", () => {
  it("lists folders with safe metadata only", async () => {
    const res = await post({ storeId: G_STORE_ID, parentFolderId: "milanoFolderId1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.folder).toEqual({ id: "milanoFolderId1", name: "Milano", kind: "folder", ignored: false });
    expect(body.folders).toEqual([expect.objectContaining({ name: "OG", ignored: true })]);
    expect(body.images.map((i: { name: string }) => i.name)).toEqual(["image-01.jpg", "image-02.JPG", "photo.webp", "pic.png"]);
    expect(Object.keys(body.folders[0]).sort()).toEqual(["createdTime", "id", "ignored", "modifiedTime", "name", "parentId"]);
  });

  it("defaults to My Drive", async () => {
    const body = await (await post({ storeId: G_STORE_ID })).json();
    expect(body.folder.name).toBe("My Drive");
  });

  it("uses the store's ignored_folders setting", async () => {
    mocks.settings = { ignored_folders: ["OG", "SOF-002"], allowed_image_types: ["jpg"] };
    const body = await (await post({ storeId: G_STORE_ID, parentFolderId: "sofaFolderId001" })).json();
    expect(body.folders.find((f: { name: string }) => f.name === "SOF-002").ignored).toBe(true);
    const milano = await (await post({ storeId: G_STORE_ID, parentFolderId: "milanoFolderId1" })).json();
    expect(milano.images.map((i: { name: string }) => i.name)).toEqual(["image-01.jpg", "image-02.JPG"]);
  });

  it("10. signed-out → 401 (JSON, no redirect)", async () => {
    mocks.ctx = null;
    const res = await post({ storeId: G_STORE_ID });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Please sign in again." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expired session → 401", async () => {
    mocks.ctxError = new SessionExpiredError();
    expect((await post({ storeId: G_STORE_ID })).status).toBe(401);
  });

  it("member → 403 (browsing reveals the connected account's Drive)", async () => {
    mocks.ctx = ctx("member");
    expect((await post({ storeId: G_STORE_ID })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("9. workspace A → workspace B's store: 404, Google never called", async () => {
    const res = await post({ storeId: OTHER_STORE, parentFolderId: "sofaFolderId001" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "We couldn't find this store in your workspace." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bundle.repo.getCredentials).not.toHaveBeenCalled();
  });

  it("invalid store id → 404", async () => {
    expect((await post({ storeId: "nope" })).status).toBe(404);
  });

  it("11. Google not connected → 409 with the friendly message", async () => {
    const res = await post({ storeId: NOT_CONNECTED_STORE });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Connect Google Drive before browsing folders." });
  });

  it("connection needs renewing → 409", async () => {
    const res = await post({ storeId: RECONNECT_STORE });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Google Drive connection needs to be renewed.");
  });

  it("revoked grant discovered at refresh → 409 renew message", async () => {
    bundle.state.creds = { ...bundle.state.creds!, tokenExpiresAt: new Date(0) };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const res = await post({ storeId: G_STORE_ID, parentFolderId: "sofaFolderId001" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Google Drive connection needs to be renewed.");
  });

  it("8. invalid folder → 400; inaccessible → 404; file → 400", async () => {
    expect((await post({ storeId: G_STORE_ID, parentFolderId: "../../etc" })).status).toBe(400);
    const gone = await post({ storeId: G_STORE_ID, parentFolderId: "doesNotExist123" });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe("This folder is no longer accessible.");
    expect((await post({ storeId: G_STORE_ID, parentFolderId: "notesFileId0004" })).status).toBe(400);
  });

  it("a folder ID can't bypass authorization: other accounts' folders are invisible (404)", async () => {
    const res = await post({ storeId: G_STORE_ID, parentFolderId: "privateFolder01" });
    expect(res.status).toBe(404);
  });

  it("Google API failure → friendly 503", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    const res = await post({ storeId: G_STORE_ID, parentFolderId: "sofaFolderId001" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Google Drive is temporarily unavailable. We'll try again shortly.");
  });

  it("non-JSON → 415; bad body → 400", async () => {
    expect((await post("storeId=x", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await post("{bad")).status).toBe(400);
    expect((await post({ storeId: G_STORE_ID, search: "x".repeat(101) })).status).toBe(400);
  });

  it("tokens / secrets never appear in responses or logs", async () => {
    const ok = await (await post({ storeId: G_STORE_ID, parentFolderId: "milanoFolderId1" })).text();
    const bad = await (await post({ storeId: G_STORE_ID, parentFolderId: "doesNotExist123" })).text();
    for (const text of [ok, bad, ...logs]) {
      for (const secret of [ACCESS, REFRESH, googleConfig.clientSecret, "v1."]) expect(text).not.toContain(secret);
    }
  });

  it("is a JSON API path (401, not a login redirect) and not public", () => {
    expect(isJsonApiPath("/api/google/folders")).toBe(true);
    expect(isPublicPath("/api/google/folders")).toBe(false);
  });
});

describe("selectGoogleRootFolder action", () => {
  it("6. owner selects Sofa → saved on the existing row; response has no tokens", async () => {
    const r = await actions.selectGoogleRootFolder(G_STORE_ID, "sofaFolderId001");
    expect(r).toEqual({ ok: true, message: 'Root folder set to "Sofa".', folder: { id: "sofaFolderId001", name: "Sofa" } });
    expect(bundle.state.root).toEqual({ id: "sofaFolderId001", name: "Sofa" });
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });

  it("7/13. change folder replaces the root; re-selecting the same folder adds no row", async () => {
    await actions.selectGoogleRootFolder(G_STORE_ID, "sofaFolderId001");
    await actions.selectGoogleRootFolder(G_STORE_ID, "bedsFolderId002");
    expect(bundle.state.root).toEqual({ id: "bedsFolderId002", name: "Beds" });
    await actions.selectGoogleRootFolder(G_STORE_ID, "bedsFolderId002");
    expect(bundle.state.rootUpdates).toBe(3);
    expect(bundle.repo.saveConnection).not.toHaveBeenCalled();
  });

  it("does not save a folder the user merely browsed into (explicit choice only)", async () => {
    await post({ storeId: G_STORE_ID, parentFolderId: "sof001FolderId1" });
    expect(bundle.state.root).toBeNull();
    expect(bundle.repo.setRootFolder).not.toHaveBeenCalled();
  });

  it("member → refused", async () => {
    mocks.ctx = ctx("member");
    expect(await actions.selectGoogleRootFolder(G_STORE_ID, "sofaFolderId001")).toEqual({
      error: "Only workspace owners and admins can manage the Google Drive connection.",
    });
    expect(bundle.state.root).toBeNull();
  });

  it("9. another workspace's store → not found, nothing saved", async () => {
    expect(await actions.selectGoogleRootFolder(OTHER_STORE, "sofaFolderId001")).toEqual({
      error: "We couldn't find this store in your workspace.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("10. signed out → login redirect", async () => {
    mocks.ctx = null;
    const err = await actions.selectGoogleRootFolder(G_STORE_ID, "sofaFolderId001").catch((e) => e);
    expect(String(err.digest)).toContain("/login");
  });

  it.each([
    ["root", "Please choose a folder inside your Drive, not all of My Drive."],
    ["doesNotExist123", "This folder is no longer accessible."],
    ["notesFileId0004", "Please choose a folder, not a file."],
    ["milanoOgFolder1", "This folder is ignored by the sync (e.g. OG) and can't be the root folder."],
  ])("8. rejects %s with a friendly message", async (id, message) => {
    expect(await actions.selectGoogleRootFolder(G_STORE_ID, id)).toEqual({ error: message });
    expect(bundle.state.root).toBeNull();
  });

  it("11. disconnected → friendly error", async () => {
    bundle.state.creds = null;
    expect(await actions.selectGoogleRootFolder(G_STORE_ID, "sofaFolderId001")).toEqual({
      error: "Connect Google Drive before browsing folders.",
    });
  });
});

describe("fake Drive sanity", () => {
  it("tree contains the example structure", () => {
    expect(driveTree().map((n) => n.name)).toEqual(expect.arrayContaining(["Sofa", "SOF-001", "Milano", "OG", "Roma", "Kalo"]));
  });
});
