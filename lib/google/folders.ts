import "server-only";

import { DriveApiError, type DriveClient } from "@/lib/google/client";
import { getDriveClient, type GoogleDeps } from "@/lib/google/connection";
import { GoogleFlowError } from "@/lib/google/errors";

/**
 * Server-only, READ-ONLY Google Drive folder browsing for root-folder selection.
 * Metadata only: nothing is downloaded, uploaded, moved or modified.
 *
 * Uses the store's existing Google connection (getDriveClient → refreshGoogleToken).
 * The CALLER must authorize first (user → workspace → owner/admin → store →
 * connection); see app/api/google/folders/route.ts.
 */

export const FOLDER_MIME = "application/vnd.google-apps.folder";
/** "My Drive" root alias and the virtual "Shared drives" list. */
export const MY_DRIVE = "root";
export const SHARED_DRIVES = "shared-drives";

/** Image extensions the future sync will upload (store_settings.allowed_image_types default). */
export const DEFAULT_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;
/** Folders the future sync skips entirely (store_settings.ignored_folders default). */
export const DEFAULT_IGNORED_FOLDERS = ["OG"] as const;

export const FOLDER_PAGE_SIZE = 100;
export const IMAGE_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

/** Drive IDs are URL-safe tokens. Anything else is rejected before calling Google. */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function isValidFolderRef(value: string): boolean {
  return value === MY_DRIVE || value === SHARED_DRIVES || DRIVE_ID_RE.test(value);
}

export type FolderItem = {
  id: string;
  name: string;
  parentId: string | null;
  createdTime: string | null;
  modifiedTime: string | null;
  /** Matches store_settings.ignored_folders (e.g. "OG"): the sync will skip it. */
  ignored: boolean;
  /** A shared drive (top level of "Shared drives"). */
  sharedDrive?: boolean;
};

export type ImageItem = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
};

export type FolderListing = {
  folder: { id: string; name: string; kind: "my-drive" | "shared-drives" | "folder"; ignored: boolean };
  folders: FolderItem[];
  /** Pass back as pageToken to load more folders. */
  nextPageToken: string | null;
  /** Supported images directly in this folder (first page only; metadata only). */
  images: ImageItem[];
  imagesTruncated: boolean;
  /** The applied name search (folders only), if any. */
  search: string | null;
};

export type BrowseSettings = { ignoredFolders: readonly string[]; imageExtensions: readonly string[] };

const DEFAULT_SETTINGS: BrowseSettings = {
  ignoredFolders: DEFAULT_IGNORED_FOLDERS,
  imageExtensions: DEFAULT_IMAGE_EXTENSIONS,
};

/** Escape a value for a Drive query string literal ('…'). */
export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();

export function isIgnoredFolder(name: string, ignoredFolders: readonly string[] = DEFAULT_IGNORED_FOLDERS): boolean {
  const n = norm(name);
  return ignoredFolders.some((f) => norm(f) === n);
}

/** jpg / jpeg / png / webp by file extension (case-insensitive). SVG, PDF, ZIP, … are excluded. */
export function isSupportedImage(name: string, extensions: readonly string[] = DEFAULT_IMAGE_EXTENSIONS): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return Boolean(m && extensions.map((e) => e.toLowerCase()).includes(m[1]!.toLowerCase()));
}

/** Query for the DIRECT sub-folders of a folder (optionally name search), never the whole Drive. */
export function buildFolderQuery(parentId: string, search?: string | null): string {
  const parts = [`'${escapeDriveQuery(parentId)}' in parents`, `mimeType = '${FOLDER_MIME}'`, "trashed = false"];
  if (search) parts.push(`name contains '${escapeDriveQuery(search)}'`);
  return parts.join(" and ");
}

/** Query for image files directly inside a folder (extension rule applied afterwards). */
export function buildImageQuery(parentId: string): string {
  return [`'${escapeDriveQuery(parentId)}' in parents`, "mimeType contains 'image/'", "trashed = false"].join(" and ");
}

const LIST_COMMON = {
  supportsAllDrives: "true",
  includeItemsFromAllDrives: "true",
  corpora: "allDrives",
} as const;

type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  driveId?: string;
};

function toFolder(f: DriveFile, settings: BrowseSettings): FolderItem {
  return {
    id: f.id,
    name: f.name,
    parentId: f.parents?.[0] ?? null,
    createdTime: f.createdTime ?? null,
    modifiedTime: f.modifiedTime ?? null,
    ignored: isIgnoredFolder(f.name, settings.ignoredFolders),
  };
}

/** Map Drive errors on a specific folder to user-facing flow errors. */
function folderError(error: unknown, storeId: string): never {
  if (error instanceof DriveApiError) {
    if (error.kind === "not_found") throw new GoogleFlowError("folder_inaccessible", { storeId });
    if (error.kind === "forbidden") throw new GoogleFlowError("drive_forbidden", { storeId });
    if (error.kind === "bad_request") throw new GoogleFlowError("invalid_folder", { storeId });
    if (error.kind === "unauthorized" || error.kind === "insufficient_scope") throw new GoogleFlowError("connection_expired", { storeId });
    if (error.kind === "api_disabled") throw new GoogleFlowError("drive_api_disabled", { storeId });
  }
  throw error;
}

/**
 * Re-check a folder on Google's side: exists, not trashed, is a folder, and
 * the connected account can read it. Returns Drive's own name (never the
 * browser's). Used before saving a root folder.
 */
export async function getFolder(
  storeId: string,
  folderId: string,
  deps: GoogleDeps,
  settings: BrowseSettings = DEFAULT_SETTINGS,
  drive?: DriveClient,
): Promise<{ id: string; name: string; ignored: boolean; driveId: string | null }> {
  if (!DRIVE_ID_RE.test(folderId)) throw new GoogleFlowError("invalid_folder", { storeId });
  const client = drive ?? (await getDriveClient(storeId, deps));
  let f: DriveFile;
  try {
    f = await client.get<DriveFile>(`files/${folderId}`, {
      fields: "id,name,mimeType,trashed,driveId",
      supportsAllDrives: "true",
    });
  } catch (error) {
    folderError(error, storeId);
  }
  if (f.mimeType !== FOLDER_MIME) throw new GoogleFlowError("not_a_folder", { storeId });
  if (f.trashed) throw new GoogleFlowError("folder_inaccessible", { storeId });
  return { id: f.id, name: f.name, ignored: isIgnoredFolder(f.name, settings.ignoredFolders), driveId: f.driveId ?? null };
}

/**
 * One page of the DIRECT sub-folders of `parentId` (+ the first page of
 * supported images in it). Never walks the Drive tree.
 * parentId: "root" (My Drive), "shared-drives" (list of shared drives) or a folder ID.
 */
export async function listFolders(
  input: { storeId: string; parentFolderId: string; search?: string | null; pageToken?: string | null },
  deps: GoogleDeps,
  settings: BrowseSettings = DEFAULT_SETTINGS,
): Promise<FolderListing> {
  const { storeId, parentFolderId } = input;
  if (!isValidFolderRef(parentFolderId)) throw new GoogleFlowError("invalid_folder", { storeId });
  const search = input.search?.trim().slice(0, MAX_SEARCH_LENGTH) || null;
  const pageToken = input.pageToken && input.pageToken.length <= 2048 ? input.pageToken : null;

  const drive = await getDriveClient(storeId, deps);

  // ---- Shared drives (top-level list) ----
  if (parentFolderId === SHARED_DRIVES) {
    try {
      const res = await drive.get<{ drives?: { id: string; name: string }[]; nextPageToken?: string }>("drives", {
        pageSize: String(FOLDER_PAGE_SIZE),
        fields: "nextPageToken,drives(id,name)",
        ...(pageToken ? { pageToken } : {}),
        ...(search ? { q: `name contains '${escapeDriveQuery(search)}'` } : {}),
      });
      return {
        folder: { id: SHARED_DRIVES, name: "Shared drives", kind: "shared-drives", ignored: false },
        folders: (res.drives ?? []).map((d) => ({
          id: d.id,
          name: d.name,
          parentId: null,
          createdTime: null,
          modifiedTime: null,
          ignored: false,
          sharedDrive: true,
        })),
        nextPageToken: res.nextPageToken ?? null,
        images: [],
        imagesTruncated: false,
        search,
      };
    } catch (error) {
      folderError(error, storeId);
    }
  }

  // ---- A folder (or My Drive) ----
  const current =
    parentFolderId === MY_DRIVE
      ? { id: MY_DRIVE, name: "My Drive", kind: "my-drive" as const, ignored: false }
      : await getFolder(storeId, parentFolderId, deps, settings, drive).then((f) => ({
          id: f.id,
          name: f.name,
          kind: "folder" as const,
          ignored: f.ignored,
        }));

  let folderRes: { files?: DriveFile[]; nextPageToken?: string };
  try {
    folderRes = await drive.get("files", {
      ...LIST_COMMON,
      q: buildFolderQuery(parentFolderId, search),
      pageSize: String(FOLDER_PAGE_SIZE),
      orderBy: "name_natural",
      fields: "nextPageToken,files(id,name,parents,createdTime,modifiedTime)",
      ...(pageToken ? { pageToken } : {}),
    });
  } catch (error) {
    folderError(error, storeId);
  }

  // Images: only on the first page of a non-search listing (metadata only).
  let images: ImageItem[] = [];
  let imagesTruncated = false;
  if (!pageToken && !search && parentFolderId !== MY_DRIVE) {
    try {
      const imgRes = await drive.get<{ files?: DriveFile[]; nextPageToken?: string }>("files", {
        ...LIST_COMMON,
        q: buildImageQuery(parentFolderId),
        pageSize: String(IMAGE_PAGE_SIZE),
        orderBy: "name_natural",
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
      });
      images = (imgRes.files ?? [])
        .filter((f) => isSupportedImage(f.name, settings.imageExtensions))
        .map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType ?? "",
          modifiedTime: f.modifiedTime ?? null,
          size: f.size !== undefined && Number.isFinite(Number(f.size)) ? Number(f.size) : null,
        }));
      imagesTruncated = Boolean(imgRes.nextPageToken);
    } catch (error) {
      folderError(error, storeId);
    }
  }

  return {
    folder: current,
    folders: (folderRes.files ?? []).map((f) => toFolder(f, settings)),
    nextPageToken: folderRes.nextPageToken ?? null,
    images,
    imagesTruncated,
    search,
  };
}

/**
 * Save the store's image ROOT folder (explicit user choice). Re-checks the
 * folder with Google (exists, not trashed, is a folder, accessible to the
 * connected account) and stores Google's ID + name — never the browser's name.
 * Replaces any previous root on the same connection row; never creates rows.
 */
export async function selectRootFolder(
  input: { storeId: string; workspaceId: string; userId: string; folderId: string },
  deps: GoogleDeps,
  settings: BrowseSettings = DEFAULT_SETTINGS,
): Promise<{ id: string; name: string }> {
  const { storeId, folderId } = input;
  if (folderId === MY_DRIVE) throw new GoogleFlowError("my_drive_root", { storeId });
  if (!DRIVE_ID_RE.test(folderId)) throw new GoogleFlowError("invalid_folder", { storeId });

  const creds = await deps.repo.getCredentials(storeId);
  if (!creds) throw new GoogleFlowError("google_not_connected", { storeId });
  if (creds.connectionStatus !== "connected") throw new GoogleFlowError("connection_expired", { storeId });

  const folder = await getFolder(storeId, folderId, deps, settings);
  if (folder.ignored) throw new GoogleFlowError("ignored_folder", { storeId });

  const saved = await deps.repo.setRootFolder({
    storeId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    googleAccountId: creds.googleAccountId,
    folderId: folder.id,
    folderName: folder.name,
  });
  // The connection changed meanwhile (disconnected / other Google account): don't attach the folder.
  if (!saved) throw new GoogleFlowError("google_not_connected", { storeId });
  // Prompt 12: the selected root is also one of the store's category roots (idempotent).
  await deps.repo.addCategoryRoot({
    storeId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    googleAccountId: creds.googleAccountId,
    folderId: folder.id,
    folderName: folder.name,
  });
  return { id: folder.id, name: folder.name };
}
