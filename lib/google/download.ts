import "server-only";

import { createHash } from "node:crypto";

import { classifyDriveStatus, DRIVE_API_BASE, DriveApiError, parseRetryAfter, type DriveClient } from "@/lib/google/client";
import { getDriveClient, refreshGoogleToken, type GoogleDeps } from "@/lib/google/connection";
import { GoogleFlowError } from "@/lib/google/errors";
import { DEFAULT_IGNORED_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, FOLDER_MIME, isIgnoredFolder } from "@/lib/google/folders";
import { extensionOf, inspectImage, MAX_IMAGE_BYTES, SUPPORTED_IMAGE_TYPES } from "@/lib/shopify/media-validation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Server-only, READ-ONLY Google Drive image downloader (Drive API v3).
 *
 *   server context (workspace) → store → Google connection (connected, same account
 *   that selected the root) → root folder (exists, folder, not trashed) → file
 *   (exists, not trashed, image) → file is INSIDE the root (ancestor walk, no
 *   ignored folder such as OG on the way) → size ≤ 20 MB → binary download
 *   (alt=media, streamed with a hard 20 MB cap) → magic bytes / MIME / extension
 *   agree → SHA-256 (+ Drive md5/sha256 cross-checks) → safe result.
 *
 * Only GET requests. Nothing in Drive is ever created, changed, moved or deleted.
 * The Google token comes only from refreshGoogleToken(storeId); it is never
 * accepted from callers, returned, logged, or sent to a non-Google host.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const PERMANENT_DOWNLOAD_ERRORS = [
  "STORE_NOT_FOUND",
  "GOOGLE_DRIVE_NOT_CONNECTED",
  "GOOGLE_DRIVE_ROOT_NOT_SELECTED",
  "DRIVE_ROOT_INACCESSIBLE",
  "DRIVE_FILE_NOT_FOUND",
  "DRIVE_FILE_OUTSIDE_ROOT",
  "DRIVE_FILE_IN_IGNORED_FOLDER",
  "UNSUPPORTED_MIME_TYPE",
  "IMAGE_TOO_LARGE",
  "INVALID_IMAGE",
  "PERMISSION_DENIED",
] as const;

export const RETRYABLE_DOWNLOAD_ERRORS = [
  "GOOGLE_DRIVE_THROTTLED",
  "GOOGLE_DRIVE_UNAVAILABLE",
  "NETWORK_ERROR",
  "TOKEN_REFRESH_UNAVAILABLE",
  "DOWNLOAD_INTEGRITY_FAILED",
  "INTERNAL_ERROR",
] as const;

export type DriveDownloadErrorCode = (typeof PERMANENT_DOWNLOAD_ERRORS)[number] | (typeof RETRYABLE_DOWNLOAD_ERRORS)[number];

const RETRYABLE = new Set<string>(RETRYABLE_DOWNLOAD_ERRORS);

const MESSAGES: Record<DriveDownloadErrorCode, string> = {
  STORE_NOT_FOUND: "This store wasn't found in the workspace.",
  GOOGLE_DRIVE_NOT_CONNECTED: "Google Drive isn't connected (or needs to be reconnected) for this store.",
  GOOGLE_DRIVE_ROOT_NOT_SELECTED: "Select a Google Drive root folder for this store first.",
  DRIVE_ROOT_INACCESSIBLE: "The selected Google Drive root folder is no longer accessible.",
  DRIVE_FILE_NOT_FOUND: "The Google Drive file wasn't found (or was moved to the trash).",
  DRIVE_FILE_OUTSIDE_ROOT: "The Google Drive file isn't inside this store's selected root folder.",
  DRIVE_FILE_IN_IGNORED_FOLDER: "The Google Drive file is inside an ignored folder (e.g. OG).",
  UNSUPPORTED_MIME_TYPE: "This file type isn't an allowed image type for this store.",
  IMAGE_TOO_LARGE: "Images must be 20 MB or smaller.",
  INVALID_IMAGE: "This file isn't a valid image of the type it claims to be.",
  PERMISSION_DENIED: "The connected Google account can't read this file.",
  GOOGLE_DRIVE_THROTTLED: "Google Drive is busy right now. We'll try again shortly.",
  GOOGLE_DRIVE_UNAVAILABLE: "Google Drive is temporarily unavailable. We'll try again shortly.",
  NETWORK_ERROR: "We couldn't reach Google Drive. We'll try again shortly.",
  TOKEN_REFRESH_UNAVAILABLE: "We couldn't refresh the Google Drive connection. We'll try again shortly.",
  DOWNLOAD_INTEGRITY_FAILED: "The downloaded file didn't match Google Drive's checksum. We'll try again.",
  INTERNAL_ERROR: "Something went wrong while downloading. We'll try again shortly.",
};

/** Safe-to-store/show error. Never contains tokens, URLs with credentials, or file bytes. */
export class DriveDownloadError extends Error {
  readonly code: DriveDownloadErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly publicMessage: string;
  constructor(code: DriveDownloadErrorCode, opts: { message?: string; retryAfterSeconds?: number } = {}) {
    super(`Drive download ${code}`);
    this.name = "DriveDownloadError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.publicMessage = (opts.message ?? MESSAGES[code]).slice(0, 300);
  }
}

/** Maps errors from the existing Google infrastructure (DriveApiError / GoogleFlowError). */
export function classifyDownloadError(error: unknown): DriveDownloadError {
  if (error instanceof DriveDownloadError) return error;
  if (error instanceof DriveApiError) {
    switch (error.kind) {
      case "throttled":
        return new DriveDownloadError("GOOGLE_DRIVE_THROTTLED", { retryAfterSeconds: error.retryAfterSeconds });
      case "unavailable":
        return new DriveDownloadError("GOOGLE_DRIVE_UNAVAILABLE", { retryAfterSeconds: error.retryAfterSeconds });
      case "network":
        return new DriveDownloadError("NETWORK_ERROR");
      case "not_found":
      case "bad_request":
        return new DriveDownloadError("DRIVE_FILE_NOT_FOUND");
      case "forbidden":
        return new DriveDownloadError("PERMISSION_DENIED");
      case "api_disabled":
        return new DriveDownloadError("PERMISSION_DENIED", { message: "The Google Drive API isn't enabled for this app." });
      case "unauthorized":
      case "insufficient_scope":
        return new DriveDownloadError("GOOGLE_DRIVE_NOT_CONNECTED");
    }
  }
  if (error instanceof GoogleFlowError) {
    if (error.code === "verify_failed") return new DriveDownloadError("TOKEN_REFRESH_UNAVAILABLE");
    if (error.code === "not_configured") {
      return new DriveDownloadError("GOOGLE_DRIVE_UNAVAILABLE", { message: "Google Drive isn't configured on the server yet." });
    }
    return new DriveDownloadError("GOOGLE_DRIVE_NOT_CONNECTED"); // not_connected, needs_reconnect, …
  }
  return new DriveDownloadError("INTERNAL_ERROR");
}

// ---------------------------------------------------------------------------
// Store context (read with the service role, never from the caller)
// ---------------------------------------------------------------------------

export type StoreDriveContext = {
  storeId: string;
  workspaceId: string;
  connectionStatus: string | null;
  googleAccountId: string | null;
  rootFolderId: string | null;
  rootFolderName: string | null;
  allowedImageTypes: string[];
  ignoredFolders: string[];
};

export interface DriveDownloadRepository {
  /** null when the store doesn't exist. */
  getStoreDriveContext(storeId: string): Promise<StoreDriveContext | null>;
}

export function createDriveDownloadRepository(): DriveDownloadRepository {
  const db = createAdminClient();
  return {
    async getStoreDriveContext(storeId) {
      const { data: store, error } = await db.from("stores").select("id, workspace_id").eq("id", storeId).maybeSingle();
      if (error) throw new Error("Could not load store");
      if (!store) return null;
      const [{ data: conn, error: connError }, { data: settings, error: settingsError }] = await Promise.all([
        db
          .from("google_drive_connections")
          .select("connection_status, google_account_id, root_folder_id, root_folder_name")
          .eq("store_id", storeId)
          .maybeSingle(),
        db.from("store_settings").select("allowed_image_types, ignored_folders").eq("store_id", storeId).maybeSingle(),
      ]);
      if (connError || settingsError) throw new Error("Could not load Google Drive settings");
      return {
        storeId: store.id,
        workspaceId: store.workspace_id,
        connectionStatus: conn?.connection_status ?? null,
        googleAccountId: conn?.google_account_id ?? null,
        rootFolderId: conn?.root_folder_id ?? null,
        rootFolderName: conn?.root_folder_name ?? null,
        allowedImageTypes: settings?.allowed_image_types?.length ? settings.allowed_image_types : [...DEFAULT_IMAGE_EXTENSIONS],
        ignoredFolders: settings?.ignored_folders?.length ? settings.ignored_folders : [...DEFAULT_IGNORED_FOLDERS],
      };
    },
  };
}

export type DriveDownloadDeps = GoogleDeps & {
  downloads: DriveDownloadRepository;
  timeoutMs?: number;
  /** Max folder levels between the file and the root (default 25). */
  maxDepth?: number;
};

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_FIELDS = "id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,parents,trashed,driveId";
const ANCESTOR_FIELDS = "id,name,mimeType,parents,trashed";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

type DriveFileMeta = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
  driveId?: string;
};

export type DriveImageDownload = {
  fileId: string;
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/heic";
  size: number;
  modifiedTime: string | null;
  /** Drive's md5Checksum: source-file metadata for duplicate/change detection only (not security). */
  md5Checksum: string | null;
  /** SHA-256 of the downloaded bytes (local integrity). */
  sha256: string;
  width: number;
  height: number;
  /** The Drive folder that directly contains the file (inside the root). */
  parentFolderId: string;
  /** Raw bytes. Non-enumerable: never included by JSON.stringify / spread / logs of the object. */
  readonly buffer: Buffer;
};

type Ctx = { workspaceId: string; storeId: string; fileId: string };

/** Store → workspace → connection → root checks. Returns the store's settings. */
async function loadContext(ctx: Ctx, deps: DriveDownloadDeps): Promise<StoreDriveContext & { rootFolderId: string }> {
  if (!UUID_RE.test(ctx.workspaceId) || !UUID_RE.test(ctx.storeId)) throw new DriveDownloadError("STORE_NOT_FOUND");
  const store = await deps.downloads.getStoreDriveContext(ctx.storeId);
  // Same answer for "doesn't exist" and "other workspace".
  if (!store || store.workspaceId !== ctx.workspaceId) throw new DriveDownloadError("STORE_NOT_FOUND");
  if (store.connectionStatus !== "connected") throw new DriveDownloadError("GOOGLE_DRIVE_NOT_CONNECTED");
  if (!store.rootFolderId) throw new DriveDownloadError("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
  return { ...store, rootFolderId: store.rootFolderId };
}

async function getMeta<T>(drive: DriveClient, id: string, fields: string): Promise<T> {
  return drive.get<T>(`files/${id}`, { fields, supportsAllDrives: "true" });
}

/**
 * The file must sit below the root folder: walk up its parents (breadth-first,
 * bounded) until the root is reached. Trashed ancestors are rejected; so is a
 * path that only goes through an ignored folder (e.g. OG).
 */
async function assertInsideRoot(
  drive: DriveClient,
  parents: string[],
  rootId: string,
  ignoredFolders: readonly string[],
  maxDepth: number,
): Promise<string> {
  const direct = parents[0];
  if (!direct) throw new DriveDownloadError("DRIVE_FILE_OUTSIDE_ROOT");
  let frontier = parents.map((id) => ({ id, ignored: false }));
  const seen = new Set<string>();
  let reachedViaIgnored = false;
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next: { id: string; ignored: boolean }[] = [];
    for (const node of frontier) {
      if (node.id === rootId) {
        if (!node.ignored) return direct;
        reachedViaIgnored = true;
        continue;
      }
      if (seen.has(node.id) || seen.size >= 100) continue;
      seen.add(node.id);
      let folder: DriveFileMeta;
      try {
        folder = await getMeta<DriveFileMeta>(drive, node.id, ANCESTOR_FIELDS);
      } catch (error) {
        // An ancestor we can't read is simply not a path to the root.
        if (error instanceof DriveApiError && (error.kind === "not_found" || error.kind === "forbidden")) continue;
        throw error;
      }
      if (folder.trashed || folder.mimeType !== FOLDER_MIME) continue;
      const ignored = node.ignored || isIgnoredFolder(folder.name, ignoredFolders);
      for (const p of folder.parents ?? []) next.push({ id: p, ignored });
    }
    frontier = next;
  }
  throw new DriveDownloadError(reachedViaIgnored ? "DRIVE_FILE_IN_IGNORED_FOLDER" : "DRIVE_FILE_OUTSIDE_ROOT");
}

const GOOGLE_DOWNLOAD_HOSTS = [/^www\.googleapis\.com$/, /(^|\.)googleusercontent\.com$/];

/**
 * GET files/{id}?alt=media with the store's token. Redirects are followed manually
 * (max 3) and ONLY to Google download hosts; the Authorization header is sent to
 * www.googleapis.com only. The body is streamed and aborted past 20 MB.
 */
async function fetchBinary(
  ctx: Ctx,
  deps: DriveDownloadDeps,
  token: { value: string },
): Promise<Buffer> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const first = new URL(`${DRIVE_API_BASE}/files/${ctx.fileId}`);
  first.searchParams.set("alt", "media");
  first.searchParams.set("supportsAllDrives", "true");

  let refreshed = false;
  let url = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const withAuth = url.hostname === "www.googleapis.com";
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: withAuth ? { Authorization: `Bearer ${token.value}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch {
      throw new DriveDownloadError("NETWORK_ERROR");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      let target: URL | null = null;
      try {
        target = location ? new URL(location, url) : null;
      } catch {
        target = null;
      }
      if (!target || target.protocol !== "https:" || !GOOGLE_DOWNLOAD_HOSTS.some((re) => re.test(target!.hostname))) {
        throw new DriveDownloadError("PERMISSION_DENIED", { message: "Google Drive redirected the download to an unexpected host." });
      }
      url = target;
      continue;
    }

    if (res.status === 401 && withAuth && !refreshed) {
      // Same behaviour as getDriveClient(): one forced refresh, then retry.
      refreshed = true;
      token.value = (await refreshGoogleToken(ctx.storeId, deps, { force: true })).accessToken;
      continue;
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      throw classifyDownloadError(
        new DriveApiError(classifyDriveStatus(res.status, body), `HTTP ${res.status}`, res.status, parseRetryAfter(res.headers.get("Retry-After"))),
      );
    }

    const declared = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new DriveDownloadError("IMAGE_TOO_LARGE");
    }
    return readCapped(res);
  }
  throw new DriveDownloadError("PERMISSION_DENIED", { message: "Too many redirects from Google Drive." });
}

async function readCapped(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DriveDownloadError("IMAGE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DriveDownloadError) throw error;
    throw new DriveDownloadError("NETWORK_ERROR");
  }
  return Buffer.concat(chunks, total);
}

/**
 * Downloads ONE image from the store's selected Drive root folder.
 *
 * `workspaceId` is the server-side context (the sync job's / session's workspace);
 * it is only compared against the store's own workspace, never trusted alone.
 * Root folder, Google account, allowed image types and tokens all come from the
 * store's stored configuration. Throws DriveDownloadError on every failure.
 */
export async function downloadDriveImage(ctx: Ctx, deps: DriveDownloadDeps): Promise<DriveImageDownload> {
  try {
    if (!DRIVE_ID_RE.test(ctx.fileId)) throw new DriveDownloadError("DRIVE_FILE_NOT_FOUND");
    const store = await loadContext(ctx, deps);

    // Token only from the stored connection; must still be the account that selected the root.
    const { accessToken, credentials } = await refreshGoogleToken(ctx.storeId, deps);
    if (credentials.workspaceId !== store.workspaceId) throw new DriveDownloadError("STORE_NOT_FOUND");
    if (credentials.connectionStatus !== "connected") throw new DriveDownloadError("GOOGLE_DRIVE_NOT_CONNECTED");
    if (store.googleAccountId && credentials.googleAccountId !== store.googleAccountId) {
      throw new DriveDownloadError("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
    }
    const drive = await getDriveClient(ctx.storeId, deps);

    // Root folder: exists, readable, a folder, not trashed.
    let root: DriveFileMeta;
    try {
      root = await getMeta<DriveFileMeta>(drive, store.rootFolderId, ANCESTOR_FIELDS);
    } catch (error) {
      if (error instanceof DriveApiError && (error.kind === "not_found" || error.kind === "forbidden")) {
        throw new DriveDownloadError("DRIVE_ROOT_INACCESSIBLE");
      }
      throw error;
    }
    if (root.trashed || root.mimeType !== FOLDER_MIME) throw new DriveDownloadError("DRIVE_ROOT_INACCESSIBLE");

    // File metadata.
    const meta = await getMeta<DriveFileMeta>(drive, ctx.fileId, FILE_FIELDS);
    if (!meta || meta.id !== ctx.fileId || meta.trashed) throw new DriveDownloadError("DRIVE_FILE_NOT_FOUND");
    if (meta.mimeType === FOLDER_MIME) throw new DriveDownloadError("UNSUPPORTED_MIME_TYPE", { message: "That's a folder, not an image." });

    // Type policy = the store's allowed extensions; extension and Drive MIME must agree.
    const ext = extensionOf(meta.name ?? "");
    const allowed = store.allowedImageTypes.map((t) => t.toLowerCase());
    const expectedMime = (SUPPORTED_IMAGE_TYPES as Record<string, DriveImageDownload["mimeType"]>)[ext];
    if (!ext || !allowed.includes(ext) || !expectedMime) throw new DriveDownloadError("UNSUPPORTED_MIME_TYPE");
    if ((meta.mimeType ?? "").toLowerCase() !== expectedMime) {
      throw new DriveDownloadError("UNSUPPORTED_MIME_TYPE", { message: "The file extension doesn't match its Drive file type." });
    }

    // Size before downloading (when Drive reports it).
    const metaSize = meta.size !== undefined ? Number(meta.size) : null;
    if (metaSize !== null && Number.isFinite(metaSize) && metaSize > MAX_IMAGE_BYTES) throw new DriveDownloadError("IMAGE_TOO_LARGE");

    // Location: must be inside the store's root (and not under an ignored folder).
    const parentFolderId = await assertInsideRoot(drive, meta.parents ?? [], store.rootFolderId, store.ignoredFolders, deps.maxDepth ?? 25);

    // Binary.
    const token = { value: accessToken };
    const bytes = await fetchBinary(ctx, deps, token);
    token.value = "";

    if (bytes.byteLength === 0) throw new DriveDownloadError("INVALID_IMAGE", { message: "The file is empty." });
    if (metaSize !== null && Number.isFinite(metaSize) && bytes.byteLength !== metaSize) {
      throw new DriveDownloadError("DOWNLOAD_INTEGRITY_FAILED");
    }
    const info = inspectImage(bytes);
    if (!info || info.mimeType !== expectedMime) throw new DriveDownloadError("INVALID_IMAGE");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const md5Checksum = meta.md5Checksum?.toLowerCase() ?? null;
    // Transfer integrity only (MD5 is not a security boundary).
    if (md5Checksum && createHash("md5").update(bytes).digest("hex") !== md5Checksum) {
      throw new DriveDownloadError("DOWNLOAD_INTEGRITY_FAILED");
    }
    if (meta.sha256Checksum && meta.sha256Checksum.toLowerCase() !== sha256) throw new DriveDownloadError("DOWNLOAD_INTEGRITY_FAILED");

    const result = {
      fileId: meta.id,
      filename: meta.name,
      mimeType: expectedMime,
      size: bytes.byteLength,
      modifiedTime: meta.modifiedTime ?? null,
      md5Checksum,
      sha256,
      width: info.width,
      height: info.height,
      parentFolderId,
    } as Omit<DriveImageDownload, "buffer">;
    Object.defineProperty(result, "buffer", { value: bytes, enumerable: false, writable: false });
    return result as DriveImageDownload;
  } catch (error) {
    const e = classifyDownloadError(error);
    if (e.code === "INTERNAL_ERROR") {
      console.error(`[google-download] unexpected ${error instanceof Error ? error.name : "error"}`);
    }
    throw e;
  }
}
