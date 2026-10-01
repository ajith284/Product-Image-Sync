import "server-only";

import { z } from "zod";

import { GOOGLE_FLOW_MESSAGES } from "@/lib/google/errors";
import { DEFAULT_IGNORED_FOLDERS, DEFAULT_IMAGE_EXTENSIONS, type BrowseSettings } from "@/lib/google/folders";
import { createClient } from "@/lib/supabase/server";
import { hasPermission, loadWorkspaceContext, SessionExpiredError } from "@/lib/workspace";

export type DriveBrowseAccess =
  | { ok: true; userId: string; workspaceId: string; storeId: string; settings: BrowseSettings }
  | { ok: false; status: 401 | 403 | 404 | 409; error: string };

export const BROWSE_MESSAGES = {
  signedOut: "Please sign in again.",
  noWorkspace: "You don't belong to a workspace yet.",
  forbidden: "Only workspace owners and admins can browse and choose the Google Drive folder.",
  storeNotFound: "We couldn't find this store in your workspace.",
} as const;

/**
 * Authorization for Drive folder browsing / root selection, in order:
 * 1. signed-in user (verified JWT)          → 401
 * 2. current workspace membership            → 403
 * 3. owner/admin (browsing shows the connected account's Drive) → 403
 * 4. store belongs to that workspace (RLS + explicit filter)    → 404
 * 5. Google Drive connection exists and is connected            → 409
 * Also loads the store's sync settings (ignored folders, image types).
 * The store id / folder id from the request are never trusted on their own.
 */
export async function authorizeDriveBrowse(storeId: string): Promise<DriveBrowseAccess> {
  let ctx: Awaited<ReturnType<typeof loadWorkspaceContext>>;
  try {
    ctx = await loadWorkspaceContext();
  } catch (error) {
    if (error instanceof SessionExpiredError) return { ok: false, status: 401, error: BROWSE_MESSAGES.signedOut };
    throw error;
  }
  if (!ctx) return { ok: false, status: 401, error: BROWSE_MESSAGES.signedOut };
  if (!ctx.workspace) return { ok: false, status: 403, error: BROWSE_MESSAGES.noWorkspace };
  const workspaceCtx = { ...ctx, workspace: ctx.workspace };
  if (!hasPermission(workspaceCtx, "manageStores")) return { ok: false, status: 403, error: BROWSE_MESSAGES.forbidden };

  // Same answer for invalid / other workspace / missing: no enumeration.
  if (!z.uuid().safeParse(storeId).success) return { ok: false, status: 404, error: BROWSE_MESSAGES.storeNotFound };

  const workspaceId = ctx.workspace.workspaceId;
  const supabase = await createClient();
  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (storeError) throw new Error("Could not load store");
  if (!store) return { ok: false, status: 404, error: BROWSE_MESSAGES.storeNotFound };

  const [{ data: connection, error: connError }, { data: settingsRow }] = await Promise.all([
    supabase.from("google_drive_connections").select("connection_status").eq("store_id", storeId).maybeSingle(),
    supabase.from("store_settings").select("ignored_folders, allowed_image_types").eq("store_id", storeId).maybeSingle(),
  ]);
  if (connError) throw new Error("Could not load Google Drive connection");
  if (!connection || connection.connection_status === "disconnected" || connection.connection_status === "pending") {
    return { ok: false, status: 409, error: GOOGLE_FLOW_MESSAGES.google_not_connected };
  }
  if (connection.connection_status !== "connected") {
    return { ok: false, status: 409, error: GOOGLE_FLOW_MESSAGES.connection_expired };
  }

  return {
    ok: true,
    userId: ctx.user.id,
    workspaceId,
    storeId,
    settings: {
      ignoredFolders: settingsRow?.ignored_folders?.length ? settingsRow.ignored_folders : DEFAULT_IGNORED_FOLDERS,
      imageExtensions: settingsRow?.allowed_image_types?.length ? settingsRow.allowed_image_types : DEFAULT_IMAGE_EXTENSIONS,
    },
  };
}
