"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { startGoogleOAuth } from "@/lib/google/auth";
import { addCategoryRoot, removeCategoryRoot } from "@/lib/google/category-roots";
import { DriveApiError } from "@/lib/google/client";
import { disconnectGoogle, verifyGoogleConnection } from "@/lib/google/connection";
import { DEFAULT_IGNORED_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, selectRootFolder } from "@/lib/google/folders";
import { getGoogleDeps, logGoogleError, toGoogleFlowError } from "@/lib/google/runtime";
import { authorizeStoreManager } from "@/lib/stores/authorize";
import { createClient } from "@/lib/supabase/server";

export type GoogleActionState = { ok?: boolean; message?: string; error?: string } | undefined;

const authorizeStore = (storeId: string) =>
  authorizeStoreManager(storeId, "Only workspace owners and admins can manage the Google Drive connection.");

export async function connectGoogleDrive(storeId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };

  let url: string;
  try {
    url = await startGoogleOAuth({ userId: auth.ctx.user.id, storeId }, getGoogleDeps());
  } catch (error) {
    logGoogleError("start", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
  redirect(url); // to https://accounts.google.com/o/oauth2/v2/auth
}

export async function verifyGoogleDrive(storeId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  try {
    const result = await verifyGoogleConnection(storeId, getGoogleDeps(), { log: true });
    revalidatePath(`/stores/${storeId}`);
    return result.ok
      ? { ok: true, message: `Google Drive is connected${result.email ? ` (${result.email})` : ""}. Everything looks good.` }
      : { error: result.message };
  } catch (error) {
    logGoogleError("verify", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}

export async function disconnectGoogleDrive(storeId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  try {
    await disconnectGoogle(storeId, auth.ctx.user.id, getGoogleDeps());
    revalidatePath(`/stores/${storeId}`);
    return { ok: true, message: "Google Drive disconnected. Your sync history was kept." };
  } catch (error) {
    logGoogleError("disconnect", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}

export type RootFolderState = GoogleActionState & { folder?: { id: string; name: string } };

/**
 * Save the store's image root folder. Owner/admin only; the folder is re-checked
 * with Google server-side (exists, folder, not trashed, accessible, not ignored)
 * and only Google's ID + name are stored on the existing connection row.
 */
export async function selectGoogleRootFolder(storeId: string, folderId: string): Promise<RootFolderState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  if (typeof folderId !== "string" || folderId.length > 200) return { error: "That isn't a valid Google Drive folder." };

  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("store_settings")
    .select("ignored_folders, allowed_image_types")
    .eq("store_id", storeId)
    .maybeSingle();

  try {
    const folder = await selectRootFolder(
      { storeId, workspaceId: auth.ctx.workspace.workspaceId, userId: auth.ctx.user.id, folderId },
      getGoogleDeps(),
      {
        ignoredFolders: settings?.ignored_folders?.length ? settings.ignored_folders : DEFAULT_IGNORED_FOLDERS,
        imageExtensions: settings?.allowed_image_types?.length ? settings.allowed_image_types : DEFAULT_IMAGE_EXTENSIONS,
      },
    );
    revalidatePath(`/stores/${storeId}`);
    return { ok: true, message: `Root folder set to "${folder.name}".`, folder };
  } catch (error) {
    logGoogleError("select-root", error);
    if (error instanceof DriveApiError) return { error: error.userMessage };
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}

/** Store settings that decide ignored folders / image types (defaults when unset). */
async function browseSettings(storeId: string) {
  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("store_settings")
    .select("ignored_folders, allowed_image_types")
    .eq("store_id", storeId)
    .maybeSingle();
  return {
    ignoredFolders: settings?.ignored_folders?.length ? settings.ignored_folders : DEFAULT_IGNORED_FOLDERS,
    imageExtensions: settings?.allowed_image_types?.length ? settings.allowed_image_types : DEFAULT_IMAGE_EXTENSIONS,
  };
}

/**
 * Connect a CATEGORY folder (e.g. "Sofa image", "Sofa bed image"). Owner/admin only.
 * Code folders (SOF-001) and product folders (Milano) below it are found by the
 * scanner — users never connect those. Re-checked with Google server-side.
 */
export async function addGoogleCategoryRoot(storeId: string, folderId: string): Promise<RootFolderState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  if (typeof folderId !== "string" || folderId.length > 200) return { error: "That isn't a valid Google Drive folder." };
  try {
    const folder = await addCategoryRoot(
      { storeId, workspaceId: auth.ctx.workspace.workspaceId, userId: auth.ctx.user.id, folderId },
      getGoogleDeps(),
      await browseSettings(storeId),
    );
    revalidatePath(`/stores/${storeId}`);
    return { ok: true, message: `Category folder "${folder.name}" connected.`, folder };
  } catch (error) {
    logGoogleError("add-category-root", error);
    if (error instanceof DriveApiError) return { error: error.userMessage };
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}

/** Disconnect a category folder (configuration only: nothing in Drive or the sync history changes). */
export async function removeGoogleCategoryRoot(storeId: string, folderId: string): Promise<GoogleActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  if (typeof folderId !== "string" || folderId.length > 200) return { error: "That isn't a valid Google Drive folder." };
  try {
    const removed = await removeCategoryRoot(
      { storeId, workspaceId: auth.ctx.workspace.workspaceId, userId: auth.ctx.user.id, folderId },
      getGoogleDeps(),
    );
    revalidatePath(`/stores/${storeId}`);
    return removed ? { ok: true, message: "Category folder disconnected." } : { error: "That category folder isn't connected." };
  } catch (error) {
    logGoogleError("remove-category-root", error);
    return { error: toGoogleFlowError(error, storeId).userMessage };
  }
}
