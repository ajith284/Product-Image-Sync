import { vi } from "vitest";

import { encryptToken, googleTokenContext } from "@/lib/google/crypto";
import type { GoogleDeps } from "@/lib/google/connection";
import { ACCESS, fakeGoogleRepo, G_NOW, G_STORE_ID, G_WORKSPACE_ID, googleConfig, json, REFRESH } from "./google-fakes";

export const FOLDER = "application/vnd.google-apps.folder";

export type FakeNode = {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  trashed?: boolean;
  size?: string;
  /** Not readable by the connected account. */
  private?: boolean;
};

/**
 * Example Drive:
 *   My Drive
 *   ├── Sofa
 *   │   ├── SOF-001 / Milano / image-01.jpg, image-02.JPG, pic.png, photo.webp, logo.svg, spec.pdf, all.zip, raw.heic, OG/OG-image.jpg
 *   │   ├── SOF-002 / Roma / image-01.jpg, image-02.jpg
 *   │   └── SOF-003 / Kalo
 *   ├── Beds
 *   ├── Old (trashed)
 *   └── notes.pdf
 *   Shared drive "Team Drive" / Catalog
 */
export function driveTree(): FakeNode[] {
  const f = (id: string, name: string, parent: string, extra: Partial<FakeNode> = {}): FakeNode => ({
    id,
    name,
    mimeType: FOLDER,
    parent,
    ...extra,
  });
  const file = (id: string, name: string, parent: string, mimeType: string, size = "1024"): FakeNode => ({
    id,
    name,
    mimeType,
    parent,
    size,
  });
  return [
    f("sofaFolderId001", "Sofa", "root"),
    f("bedsFolderId002", "Beds", "root"),
    f("oldFolderId0003", "Old", "root", { trashed: true }),
    file("notesFileId0004", "notes.pdf", "root", "application/pdf"),
    f("sof001FolderId1", "SOF-001", "sofaFolderId001"),
    f("sof002FolderId2", "SOF-002", "sofaFolderId001"),
    f("sof003FolderId3", "SOF-003", "sofaFolderId001"),
    f("milanoFolderId1", "Milano", "sof001FolderId1"),
    f("romaFolderId002", "Roma", "sof002FolderId2"),
    f("kaloFolderId003", "Kalo", "sof003FolderId3"),
    file("milanoImg01xxxx", "image-01.jpg", "milanoFolderId1", "image/jpeg", "204800"),
    file("milanoImg02xxxx", "image-02.JPG", "milanoFolderId1", "image/jpeg"),
    file("milanoPngxxxxxx", "pic.png", "milanoFolderId1", "image/png"),
    file("milanoWebpxxxxx", "photo.webp", "milanoFolderId1", "image/webp"),
    file("milanoSvgxxxxxx", "logo.svg", "milanoFolderId1", "image/svg+xml"),
    file("milanoHeicxxxxx", "raw.heic", "milanoFolderId1", "image/heic"),
    file("milanoPdfxxxxxx", "spec.pdf", "milanoFolderId1", "application/pdf"),
    file("milanoZipxxxxxx", "all.zip", "milanoFolderId1", "application/zip"),
    f("milanoOgFolder1", "OG", "milanoFolderId1"),
    file("ogImagexxxxxxxx", "OG-image.jpg", "milanoOgFolder1", "image/jpeg"),
    file("romaImg01xxxxxx", "image-01.jpg", "romaFolderId002", "image/jpeg"),
    file("romaImg02xxxxxx", "image-02.jpg", "romaFolderId002", "image/jpeg"),
    f("teamDriveId0001", "Team Drive", "__drives__"),
    f("catalogFolder01", "Catalog", "teamDriveId0001"),
    f("privateFolder01", "Someone else's", "root", { private: true }),
  ];
}

type Call = { path: string; params: Record<string, string> };

/** Minimal Drive v3 simulator: files.list (q parsing + pagination), files.get, drives.list. */
export function fakeDriveFetch(nodes: FakeNode[] = driveTree(), opts: { calls?: Call[] } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") {
      return json({ access_token: ACCESS, expires_in: 3599, scope: "x", token_type: "Bearer" });
    }
    if (!url.href.startsWith("https://www.googleapis.com/drive/v3/")) throw new Error(`unexpected fetch ${url.href}`);
    const path = url.pathname.replace("/drive/v3/", "");
    const params = Object.fromEntries(url.searchParams.entries());
    opts.calls?.push({ path, params });

    const page = <T,>(items: T[]) => {
      const size = Number(params.pageSize ?? 100);
      const start = params.pageToken ? Number(params.pageToken.replace("tok-", "")) : 0;
      const slice = items.slice(start, start + size);
      const next = start + size < items.length ? `tok-${start + size}` : undefined;
      return { slice, next };
    };

    if (path === "drives") {
      const drives = nodes.filter((n) => n.parent === "__drives__");
      const { slice, next } = page(drives);
      return json({ drives: slice.map((d) => ({ id: d.id, name: d.name })), ...(next ? { nextPageToken: next } : {}) });
    }

    if (path.startsWith("files/")) {
      const id = path.slice("files/".length);
      const n = nodes.find((x) => x.id === id);
      if (!n || n.private) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
      return json({ id: n.id, name: n.name, mimeType: n.mimeType, trashed: Boolean(n.trashed) });
    }

    if (path === "files") {
      const q = params.q ?? "";
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const wantFolder = q.includes(`mimeType = '${FOLDER}'`);
      const wantImage = q.includes("mimeType contains 'image/'");
      const nameTerm = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      let items = nodes.filter(
        (n) =>
          n.parent === parent &&
          !n.private &&
          (!q.includes("trashed = false") || !n.trashed) &&
          (!wantFolder || n.mimeType === FOLDER) &&
          (!wantImage || n.mimeType.startsWith("image/")),
      );
      // Drive's "name contains" is prefix matching (per word).
      if (nameTerm) items = items.filter((n) => n.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(nameTerm.toLowerCase())) || n.name.toLowerCase().startsWith(nameTerm.toLowerCase()));
      items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const { slice, next } = page(items);
      return json({
        files: slice.map((n) => ({
          id: n.id,
          name: n.name,
          mimeType: n.mimeType,
          parents: [n.parent],
          modifiedTime: "2026-09-30T10:00:00.000Z",
          createdTime: "2026-09-01T10:00:00.000Z",
          ...(n.size ? { size: n.size } : {}),
        })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    throw new Error(`unexpected Drive path ${path}`);
  });
}

/** Connected store with valid encrypted credentials for account "google-sub-123". */
export function driveDeps(fetchImpl: ReturnType<typeof fakeDriveFetch>) {
  const bundle = fakeGoogleRepo();
  const key = googleConfig.tokenEncryptionKey;
  bundle.state.creds = {
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
  const deps: GoogleDeps = { config: googleConfig, repo: bundle.repo, fetch: fetchImpl as unknown as typeof fetch, now: () => G_NOW };
  return { deps, ...bundle };
}
