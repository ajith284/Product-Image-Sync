import { describe, expect, it } from "vitest";

import { addCategoryRoot, removeCategoryRoot } from "@/lib/google/category-roots";
import type { GoogleDeps } from "@/lib/google/connection";
import { encryptToken, googleTokenContext } from "@/lib/google/crypto";
import { GoogleFlowError } from "@/lib/google/errors";
import { selectRootFolder } from "@/lib/google/folders";
import { ACCESS, fakeGoogleRepo, G_NOW, G_STORE_ID, G_USER_ID, G_WORKSPACE_ID, googleConfig, googleFetch, json, REFRESH } from "./helpers/google-fakes";

const FOLDER = "application/vnd.google-apps.folder";
const FOLDERS: Record<string, { name: string; mimeType: string; trashed?: boolean }> = {
  sofaImageFolder1: { name: "Sofa image", mimeType: FOLDER },
  sofaBedImageFld1: { name: "Sofa bed image", mimeType: FOLDER },
  ogFolderxxxxxxxx: { name: "OG", mimeType: FOLDER },
  aFilexxxxxxxxxxx: { name: "1.jpg", mimeType: "image/jpeg" },
};
const settings = { ignoredFolders: ["OG"], imageExtensions: ["jpg", "jpeg", "png", "webp"] };

function setup(status = "connected") {
  const { repo, state } = fakeGoogleRepo();
  state.creds = {
    connectionId: "gconn-1",
    workspaceId: G_WORKSPACE_ID,
    googleAccountId: "google-sub-123",
    connectionStatus: status,
    encryptedAccessToken: encryptToken(ACCESS, googleConfig.tokenEncryptionKey, googleTokenContext(G_STORE_ID, "access")),
    encryptedRefreshToken: encryptToken(REFRESH, googleConfig.tokenEncryptionKey, googleTokenContext(G_STORE_ID, "refresh")),
    tokenExpiresAt: new Date(G_NOW + 3_600_000),
    tokenVersion: 1,
    accountShared: false,
  };
  const fetch = googleFetch({
    drive: (url) => {
      const id = url.pathname.split("/").pop()!;
      const f = FOLDERS[id];
      return f ? json({ id, name: f.name, mimeType: f.mimeType, trashed: f.trashed ?? false }) : json({ error: { code: 404 } }, 404);
    },
  });
  const deps: GoogleDeps = { config: googleConfig, repo, fetch, now: () => G_NOW };
  return { deps, state, repo };
}
const add = (deps: GoogleDeps, folderId: string) =>
  addCategoryRoot({ storeId: G_STORE_ID, workspaceId: G_WORKSPACE_ID, userId: G_USER_ID, folderId }, deps, settings);

describe("category roots (multiple connected category folders)", () => {
  it("connects several category folders; names come from Google; idempotent", async () => {
    const { deps, state } = setup();
    expect(await add(deps, "sofaImageFolder1")).toEqual({ id: "sofaImageFolder1", name: "Sofa image" });
    await add(deps, "sofaBedImageFld1");
    await add(deps, "sofaImageFolder1");
    expect(state.categoryRoots.map((r) => r.folderName)).toEqual(["Sofa image", "Sofa bed image"]);
    expect(state.categoryRoots.every((r) => r.googleAccountId === "google-sub-123")).toBe(true);
    expect(state.root).toEqual({ id: "sofaImageFolder1", name: "Sofa image" }); // single-root column kept valid
  });

  it("rejects ignored folders, files, My Drive, invalid ids and disconnected Google", async () => {
    const { deps } = setup();
    for (const [id, code] of [
      ["ogFolderxxxxxxxx", "ignored_folder"],
      ["aFilexxxxxxxxxxx", "not_a_folder"],
      ["root", "my_drive_root"],
      ["bad/../id", "invalid_folder"],
      ["missingFolder001", "folder_inaccessible"],
    ] as const) {
      await expect(add(deps, id)).rejects.toMatchObject({ code });
    }
    const off = setup("needs_reconnect");
    await expect(add(off.deps, "sofaImageFolder1")).rejects.toBeInstanceOf(GoogleFlowError);
    expect(off.state.categoryRoots).toHaveLength(0);
  });

  it("removing a root keeps the single-root column pointing at a remaining root", async () => {
    const { deps, state } = setup();
    await add(deps, "sofaImageFolder1");
    await add(deps, "sofaBedImageFld1");
    expect(await removeCategoryRoot({ storeId: G_STORE_ID, workspaceId: G_WORKSPACE_ID, userId: G_USER_ID, folderId: "sofaImageFolder1" }, deps)).toBe(true);
    expect(state.root).toEqual({ id: "sofaBedImageFld1", name: "Sofa bed image" });
  });

  it("the Prompt 7 'select root folder' also registers the folder as a category root", async () => {
    const { deps, state } = setup();
    await selectRootFolder({ storeId: G_STORE_ID, workspaceId: G_WORKSPACE_ID, userId: G_USER_ID, folderId: "sofaImageFolder1" }, deps, settings);
    expect(state.categoryRoots.map((r) => r.folderId)).toEqual(["sofaImageFolder1"]);
  });
});
