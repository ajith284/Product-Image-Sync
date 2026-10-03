"use server";

import { revalidatePath } from "next/cache";

import { N8nSyncTriggerError, triggerN8nSync } from "@/lib/n8n/web-app";
import { authorizeStoreManager } from "@/lib/stores/authorize";
import { createClient } from "@/lib/supabase/server";

export type StartStoreSyncState =
  | { ok: true; jobId: string; status: string; reused: boolean }
  | { ok: false; error: string };

export async function startStoreSync(storeId: string): Promise<StartStoreSyncState> {
  const auth = await authorizeStoreManager(storeId, "Only workspace owners and admins can start a sync.");
  if ("error" in auth) return { ok: false, error: auth.error };

  const supabase = await createClient();
  const [shopifyRes, driveRes, activeRes] = await Promise.all([
    supabase
      .from("shopify_connections")
      .select("connection_status")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabase
      .from("google_drive_connections")
      .select("connection_status, google_account_id")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabase
      .from("sync_jobs")
      .select("id, status")
      .eq("store_id", storeId)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (shopifyRes.error || driveRes.error || activeRes.error) {
    return { ok: false, error: "We couldn't check the store's sync readiness. Please try again." };
  }
  if (shopifyRes.data?.connection_status !== "connected") {
    return { ok: false, error: "Connect Shopify before starting a sync." };
  }
  if (driveRes.data?.connection_status !== "connected" || !driveRes.data.google_account_id) {
    return { ok: false, error: "Connect Google Drive before starting a sync." };
  }

  // If a job is already active, return it instead of creating another one.
  if (activeRes.data) {
    return { ok: true, jobId: activeRes.data.id, status: activeRes.data.status, reused: true };
  }

  const rootsRes = await supabase
    .from("google_drive_category_roots")
    .select("folder_id, folder_name")
    .eq("store_id", storeId)
    .eq("google_account_id", driveRes.data.google_account_id)
    .order("created_at", { ascending: true });
  if (rootsRes.error) {
    return { ok: false, error: "We couldn't read the connected category folder. Please try again." };
  }
  const roots = rootsRes.data ?? [];
  if (roots.length === 0) {
    return { ok: false, error: "Select one Google Drive category folder before starting a sync." };
  }
  if (roots.length > 1) {
    return {
      ok: false,
      error: "Keep only one category folder connected for this sync. Remove the other category folders and try again.",
    };
  }

  try {
    const started = await triggerN8nSync(storeId);
    revalidatePath(`/stores/${storeId}`);
    revalidatePath("/sync-jobs");
    revalidatePath("/dashboard");
    return { ok: true, jobId: started.job_id, status: started.status, reused: false };
  } catch (error) {
    if (error instanceof N8nSyncTriggerError) return { ok: false, error: error.userMessage };
    return { ok: false, error: "We couldn't start the sync. Please try again." };
  }
}
