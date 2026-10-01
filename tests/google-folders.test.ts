import { describe, expect, it } from "vitest";

import {
  buildFolderQuery,
  buildImageQuery,
  escapeDriveQuery,
  getFolder,
  isIgnoredFolder,
  isSupportedImage,
  isValidFolderRef,
  listFolders,
  selectRootFolder,
} from "@/lib/google/folders";
import { G_STORE_ID, G_USER_ID, G_WORKSPACE_ID } from "./helpers/google-fakes";
import { driveDeps, driveTree, fakeDriveFetch, FOLDER } from "./helpers/fake-drive";

const names = (xs: { name: string }[]) => xs.map((x) => x.name);
const list = (deps: ReturnType<typeof driveDeps>["deps"], parentFolderId: string, extra: { search?: string; pageToken?: string } = {}) =>
  listFolders({ storeId: G_STORE_ID, parentFolderId, ...extra }, deps);

describe("listFolders", () => {
  it("1. lists the direct sub-folders of My Drive (no images at My Drive level)", async () => {
    const calls: { path: string; params: Record<string, string> }[] = [];
    const { deps } = driveDeps(fakeDriveFetch(driveTree(), { calls }));
    const r = await list(deps, "root");
    expect(r.folder).toEqual({ id: "root", name: "My Drive", kind: "my-drive", ignored: false });
    expect(names(r.folders)).toEqual(["Beds", "Sofa"]);
    expect(r.images).toEqual([]);
    // Exactly one files.list — never a whole-Drive scan.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.q).toBe(`'root' in parents and mimeType = '${FOLDER}' and trashed = false`);
    expect(calls[0]!.params).toMatchObject({ supportsAllDrives: "true", includeItemsFromAllDrives: "true", orderBy: "name_natural" });
  });

  it("navigates Sofa → SOF-001 → Milano; the code folder is just a folder, the product folder holds images", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    const sofa = await list(deps, "sofaFolderId001");
    expect(names(sofa.folders)).toEqual(["SOF-001", "SOF-002", "SOF-003"]);
    const sof001 = await list(deps, "sof001FolderId1");
    expect(sof001.folder.name).toBe("SOF-001");
    expect(names(sof001.folders)).toEqual(["Milano"]);
    expect(sof001.images).toEqual([]);
    const milano = await list(deps, "milanoFolderId1");
    expect(milano.folder).toMatchObject({ id: "milanoFolderId1", name: "Milano", kind: "folder", ignored: false });
    expect(names(milano.folders)).toEqual(["OG"]);
  });

  it("2. pagination: follows page tokens, one page at a time", async () => {
    const nodes = driveTree();
    for (let i = 0; i < 230; i++) nodes.push({ id: `bulkFolder${String(i).padStart(5, "0")}`, name: `P${i}`, mimeType: FOLDER, parent: "bedsFolderId002" });
    const calls: { path: string; params: Record<string, string> }[] = [];
    const { deps } = driveDeps(fakeDriveFetch(nodes, { calls }));
    const p1 = await list(deps, "bedsFolderId002");
    expect(p1.folders).toHaveLength(100);
    expect(p1.nextPageToken).toBe("tok-100");
    const p2 = await list(deps, "bedsFolderId002", { pageToken: p1.nextPageToken! });
    const p3 = await list(deps, "bedsFolderId002", { pageToken: p2.nextPageToken! });
    expect(p2.folders).toHaveLength(100);
    expect(p3.folders).toHaveLength(30);
    expect(p3.nextPageToken).toBeNull();
    expect(new Set([...p1.folders, ...p2.folders, ...p3.folders].map((f) => f.id)).size).toBe(230);
    expect(calls.filter((c) => c.path === "files").map((c) => c.params.pageToken ?? null).filter(Boolean)).toEqual(["tok-100", "tok-200"]);
  });

  it("3. non-folders (files) are never returned as folders", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    const r = await list(deps, "root");
    expect(names(r.folders)).not.toContain("notes.pdf");
  });

  it("4. trashed folders are filtered out", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    expect(names((await list(deps, "root")).folders)).not.toContain("Old");
  });

  it("5. folder search inside the current location only", async () => {
    const calls: { path: string; params: Record<string, string> }[] = [];
    const { deps } = driveDeps(fakeDriveFetch(driveTree(), { calls }));
    const r = await list(deps, "sofaFolderId001", { search: " SOF-002 " });
    expect(names(r.folders)).toEqual(["SOF-002"]);
    expect(r.search).toBe("SOF-002");
    const q = calls.find((c) => c.path === "files")!.params.q;
    expect(q).toContain("'sofaFolderId001' in parents");
    expect(q).toContain("name contains 'SOF-002'");
    // A search doesn't list images.
    expect(calls.filter((c) => c.path === "files")).toHaveLength(1);
  });

  it("search values are escaped (no Drive query injection)", () => {
    expect(escapeDriveQuery("Kid's \\ sofa")).toBe("Kid\\'s \\\\ sofa");
    expect(buildFolderQuery("root", "x' or name contains '")).toBe(
      `'root' in parents and mimeType = '${FOLDER}' and trashed = false and name contains 'x\\' or name contains \\''`,
    );
  });

  it("14. OG folder is marked Ignored (default and custom ignored_folders, case-insensitive)", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    const milano = await list(deps, "milanoFolderId1");
    expect(milano.folders).toEqual([expect.objectContaining({ name: "OG", ignored: true })]);
    const og = await list(deps, "milanoOgFolder1");
    expect(og.folder.ignored).toBe(true);
    expect(isIgnoredFolder(" og ")).toBe(true);
    expect(isIgnoredFolder("OGX")).toBe(false);
    expect(isIgnoredFolder("Raw", ["OG", "raw"])).toBe(true);
  });

  it("15. supported image filtering: jpg/jpeg/png/webp only, metadata only", async () => {
    const calls: { path: string; params: Record<string, string> }[] = [];
    const { deps } = driveDeps(fakeDriveFetch(driveTree(), { calls }));
    const milano = await list(deps, "milanoFolderId1");
    expect(names(milano.images)).toEqual(["image-01.jpg", "image-02.JPG", "photo.webp", "pic.png"]);
    expect(milano.images[0]).toEqual({
      id: "milanoImg01xxxx",
      name: "image-01.jpg",
      mimeType: "image/jpeg",
      modifiedTime: "2026-09-30T10:00:00.000Z",
      size: 204800,
    });
    // svg, heic, pdf, zip excluded; OG's image is not listed in Milano.
    expect(names(milano.images)).not.toEqual(expect.arrayContaining(["logo.svg", "raw.heic", "spec.pdf", "all.zip", "OG-image.jpg"]));
    // Only metadata endpoints were called — no ?alt=media downloads.
    expect(calls.every((c) => c.params.alt !== "media")).toBe(true);
    expect(buildImageQuery("milanoFolderId1")).toBe("'milanoFolderId1' in parents and mimeType contains 'image/' and trashed = false");
    expect(isSupportedImage("A.JPEG")).toBe(true);
    expect(isSupportedImage("a.svg")).toBe(false);
    expect(isSupportedImage("jpg")).toBe(false);
    expect(isSupportedImage("a.png", ["jpg"])).toBe(false);
  });

  it("empty folder: no folders, no images", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    const kalo = await list(deps, "kaloFolderId003");
    expect(kalo.folders).toEqual([]);
    expect(kalo.images).toEqual([]);
  });

  it("shared drives are listed and browsable", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    const drives = await list(deps, "shared-drives");
    expect(drives.folders).toEqual([expect.objectContaining({ id: "teamDriveId0001", name: "Team Drive", sharedDrive: true })]);
    expect(names((await list(deps, "teamDriveId0001")).folders)).toEqual(["Catalog"]);
  });

  it("8. invalid / inaccessible folder references are rejected", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    expect(isValidFolderRef("../files")).toBe(false);
    expect(isValidFolderRef("abc")).toBe(false);
    await expect(list(deps, "bad id'!")).rejects.toMatchObject({ code: "invalid_folder" });
    await expect(list(deps, "privateFolder01")).rejects.toMatchObject({ code: "folder_inaccessible" });
    await expect(list(deps, "doesNotExist123")).rejects.toMatchObject({ code: "folder_inaccessible" });
    await expect(list(deps, "notesFileId0004")).rejects.toMatchObject({ code: "not_a_folder" });
    await expect(list(deps, "oldFolderId0003")).rejects.toMatchObject({ code: "folder_inaccessible" });
  });

  it("11. Google disconnected → not_connected (no Drive call)", async () => {
    const f = fakeDriveFetch();
    const { deps, state } = driveDeps(f);
    state.creds = null;
    await expect(list(deps, "root")).rejects.toMatchObject({ code: "not_connected" });
    expect(f).not.toHaveBeenCalled();
  });

  it("expired grant → connection_expired", async () => {
    const f = fakeDriveFetch();
    f.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 }));
    const { deps } = driveDeps(f);
    await expect(list(deps, "sofaFolderId001")).rejects.toMatchObject({ code: "connection_expired" });
  });
});

describe("selectRootFolder", () => {
  const select = (deps: ReturnType<typeof driveDeps>["deps"], folderId: string) =>
    selectRootFolder({ storeId: G_STORE_ID, workspaceId: G_WORKSPACE_ID, userId: G_USER_ID, folderId }, deps);

  it("6. saves Google's ID + name on the existing connection row", async () => {
    const { deps, state, repo } = driveDeps(fakeDriveFetch());
    expect(await select(deps, "sofaFolderId001")).toEqual({ id: "sofaFolderId001", name: "Sofa" });
    expect(state.root).toEqual({ id: "sofaFolderId001", name: "Sofa" });
    expect(repo.setRootFolder).toHaveBeenCalledWith({
      storeId: G_STORE_ID,
      workspaceId: G_WORKSPACE_ID,
      userId: G_USER_ID,
      googleAccountId: "google-sub-123",
      folderId: "sofaFolderId001",
      folderName: "Sofa",
    });
  });

  it("7. replacing the root (Sofa → Beds) overwrites the single row", async () => {
    const { deps, state } = driveDeps(fakeDriveFetch());
    await select(deps, "sofaFolderId001");
    await select(deps, "bedsFolderId002");
    expect(state.root).toEqual({ id: "bedsFolderId002", name: "Beds" });
  });

  it("13. selecting Sofa again only updates the same row (no new connection)", async () => {
    const { deps, state, repo } = driveDeps(fakeDriveFetch());
    await select(deps, "sofaFolderId001");
    await select(deps, "sofaFolderId001");
    expect(state.root).toEqual({ id: "sofaFolderId001", name: "Sofa" });
    expect(state.rootUpdates).toBe(2);
    expect(repo.saveConnection).not.toHaveBeenCalled();
  });

  it("the name comes from Google, not from the browser", async () => {
    const nodes = driveTree().map((n) => (n.id === "sofaFolderId001" ? { ...n, name: "Sofa (renamed in Drive)" } : n));
    const { deps, state } = driveDeps(fakeDriveFetch(nodes));
    await select(deps, "sofaFolderId001");
    expect(state.root?.name).toBe("Sofa (renamed in Drive)");
  });

  it.each([
    ["My Drive itself", "root", "my_drive_root"],
    ["malformed ID", "x'; drop", "invalid_folder"],
    ["a file", "notesFileId0004", "not_a_folder"],
    ["a trashed folder", "oldFolderId0003", "folder_inaccessible"],
    ["a folder the account can't access", "privateFolder01", "folder_inaccessible"],
    ["a non-existent ID", "doesNotExist123", "folder_inaccessible"],
    ["the ignored OG folder", "milanoOgFolder1", "ignored_folder"],
  ])("8. rejects %s", async (_label, id, code) => {
    const { deps, state } = driveDeps(fakeDriveFetch());
    await expect(select(deps, id)).rejects.toMatchObject({ code });
    expect(state.root).toBeNull();
  });

  it("11. Google disconnected → google_not_connected; needs reconnect → connection_expired", async () => {
    const a = driveDeps(fakeDriveFetch());
    a.state.creds = null;
    await expect(select(a.deps, "sofaFolderId001")).rejects.toMatchObject({ code: "google_not_connected" });
    const b = driveDeps(fakeDriveFetch());
    b.state.creds = { ...b.state.creds!, connectionStatus: "needs_reconnect" };
    await expect(select(b.deps, "sofaFolderId001")).rejects.toMatchObject({ code: "connection_expired" });
  });

  it("12. account switched meanwhile → folder NOT attached to the new account", async () => {
    const { deps, state, repo } = driveDeps(fakeDriveFetch());
    // getCredentials returns the old account, but by the time we save the row belongs to another account.
    repo.setRootFolder = async (input) => {
      state.creds = { ...state.creds!, googleAccountId: "another-account" };
      return input.googleAccountId === state.creds.googleAccountId;
    };
    await expect(select(deps, "sofaFolderId001")).rejects.toMatchObject({ code: "google_not_connected" });
    expect(state.root).toBeNull();
  });

  it("getFolder re-checks on Google's side", async () => {
    const { deps } = driveDeps(fakeDriveFetch());
    expect(await getFolder(G_STORE_ID, "teamDriveId0001", deps)).toMatchObject({ id: "teamDriveId0001", name: "Team Drive" });
  });
});
