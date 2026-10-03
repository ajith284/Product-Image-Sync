"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { friendlyDbError, MESSAGES } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export type RemoveStoreResult = { ok: true } | { ok: false; error: string };

export async function removeStoreFromWorkspace(storeId: string): Promise<RemoveStoreResult> {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageStores")) {
    return { ok: false, error: MESSAGES.noPermission };
  }
  if (!z.uuid().safeParse(storeId).success) {
    return { ok: false, error: "Invalid store." };
  }

  const supabase = await createClient();

  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("workspace_id", ctx.workspace.workspaceId)
    .maybeSingle();

  if (storeError) {
    return {
      ok: false,
      error: friendlyDbError(storeError, "We couldn't verify this store. Please try again."),
    };
  }
  if (!store) return { ok: false, error: "Store not found." };

  const { data: activeJob, error: activeError } = await supabase
    .from("sync_jobs")
    .select("id")
    .eq("store_id", storeId)
    .in("status", ["queued", "running"])
    .limit(1)
    .maybeSingle();

  if (activeError) {
    return {
      ok: false,
      error: friendlyDbError(activeError, "We couldn't check the current sync status. Please try again."),
    };
  }
  if (activeJob) {
    return {
      ok: false,
      error: "This store has a sync in progress. Wait for it to finish before removing the store.",
    };
  }

  const { error } = await supabase
    .from("stores")
    .delete()
    .eq("id", storeId)
    .eq("workspace_id", ctx.workspace.workspaceId);

  if (error) {
    return {
      ok: false,
      error: friendlyDbError(error, "We couldn't remove this store. Please try again."),
    };
  }

  revalidatePath("/sync-jobs");
  revalidatePath("/stores");
  revalidatePath("/dashboard");
  revalidatePath("/drive-mapping");
  revalidatePath("/review");
  revalidatePath("/activity");

  return { ok: true };
}
