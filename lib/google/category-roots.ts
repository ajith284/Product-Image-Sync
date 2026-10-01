import "server-only";

import type { GoogleDeps } from "@/lib/google/connection";
import { GoogleFlowError } from "@/lib/google/errors";
import { getFolder, MY_DRIVE, SHARED_DRIVES, type BrowseSettings } from "@/lib/google/folders";

/**
 * Multiple CATEGORY roots per store (Prompt 12): "Sofa image", "Sofa bed image", …
 * Users connect only these category-level folders; code folders (SOF-001) and
 * product folders (Milano) below them are discovered by the scanner.
 *
 * The CALLER authorizes first (session → workspace → owner/admin → store); the
 * database functions re-check workspace → owner/admin → store → connected account.
 */

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export async function addCategoryRoot(
  input: { storeId: string; workspaceId: string; userId: string; folderId: string },
  deps: GoogleDeps,
  settings: BrowseSettings,
): Promise<{ id: string; name: string }> {
  const { storeId, folderId } = input;
  if (folderId === MY_DRIVE || folderId === SHARED_DRIVES) throw new GoogleFlowError("my_drive_root", { storeId });
  if (!DRIVE_ID_RE.test(folderId)) throw new GoogleFlowError("invalid_folder", { storeId });

  const creds = await deps.repo.getCredentials(storeId);
  if (!creds) throw new GoogleFlowError("google_not_connected", { storeId });
  if (creds.connectionStatus !== "connected") throw new GoogleFlowError("connection_expired", { storeId });

  // Re-checked with Google: exists, a folder, not trashed, readable; name comes from Google.
  const folder = await getFolder(storeId, folderId, deps, settings);
  if (folder.ignored) throw new GoogleFlowError("ignored_folder", { storeId });

  const saved = await deps.repo.addCategoryRoot({
    storeId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    googleAccountId: creds.googleAccountId,
    folderId: folder.id,
    folderName: folder.name,
  });
  if (!saved) throw new GoogleFlowError("google_not_connected", { storeId });
  return { id: folder.id, name: folder.name };
}

export async function removeCategoryRoot(
  input: { storeId: string; workspaceId: string; userId: string; folderId: string },
  deps: GoogleDeps,
): Promise<boolean> {
  if (!DRIVE_ID_RE.test(input.folderId)) throw new GoogleFlowError("invalid_folder", { storeId: input.storeId });
  return deps.repo.removeCategoryRoot(input);
}
