"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { startGoogleOAuth } from "@/lib/google/auth";
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
