import "server-only";

import { isSessionError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

const REVIEW_STATUSES = ["no_product_found", "multiple_matches", "upload_failed"] as const;

function check<T extends { error: { code?: string; message?: string } | null }>(res: T, what: string): T {
  if (res.error) {
    if (isSessionError(res.error)) throw new Error("session_expired");
    throw new Error(`Could not load ${what}`);
  }
  return res;
}

async function workspaceStores(workspaceId: string) {
  const supabase = await createClient();
  const res = check(
    await supabase
      .from("stores")
      .select("id, name, shopify_domain, status")
      .eq("workspace_id", workspaceId)
      .order("name", { ascending: true }),
    "stores",
  );
  return { supabase, stores: res.data ?? [] };
}

export async function listDriveMappings(workspaceId: string) {
  const { supabase, stores } = await workspaceStores(workspaceId);
  const storeIds = stores.map((store) => store.id);
  if (!storeIds.length) return [];

  const [connectionsRes, rootsRes] = await Promise.all([
    supabase
      .from("google_drive_connections")
      .select("store_id, connection_status, google_account_id, google_account_email, root_folder_name, last_verified_at")
      .in("store_id", storeIds),
    supabase
      .from("google_drive_category_roots")
      .select("store_id, folder_id, folder_name, google_account_id, created_at")
      .in("store_id", storeIds)
      .order("created_at", { ascending: true }),
  ]);
  check(connectionsRes, "Google Drive connections");
  check(rootsRes, "Google Drive category folders");

  const connections = new Map((connectionsRes.data ?? []).map((row) => [row.store_id, row]));
  const roots = rootsRes.data ?? [];

  return stores.map((store) => {
    const connection = connections.get(store.id) ?? null;
    const accountId = connection?.google_account_id ?? null;
    return {
      ...store,
      drive: connection
        ? {
            connection_status: connection.connection_status,
            google_account_email: connection.google_account_email,
            root_folder_name: connection.root_folder_name,
            last_verified_at: connection.last_verified_at,
          }
        : null,
      categories: roots
        .filter((root) => root.store_id === store.id && accountId && root.google_account_id === accountId)
        .map((root) => ({ id: root.folder_id, name: root.folder_name, created_at: root.created_at })),
    };
  });
}

export async function listSyncJobs(workspaceId: string, limit = 100) {
  const { supabase, stores } = await workspaceStores(workspaceId);
  const storeIds = stores.map((store) => store.id);
  if (!storeIds.length) return [];

  const res = check(
    await supabase
      .from("sync_jobs")
      .select(
        "id, store_id, status, trigger_type, dry_run, created_at, started_at, completed_at, products_processed, products_synced, images_uploaded, items_total, items_skipped, items_review, items_failed, warnings_count, errors_count, error_code, error_message",
      )
      .in("store_id", storeIds)
      .order("created_at", { ascending: false })
      .limit(limit),
    "sync jobs",
  );
  const names = new Map(stores.map((store) => [store.id, store.name]));
  return (res.data ?? []).map((job) => ({ ...job, store_name: names.get(job.store_id) ?? "Store" }));
}

export async function listReviewItems(workspaceId: string, limit = 200) {
  const { supabase, stores } = await workspaceStores(workspaceId);
  const storeIds = stores.map((store) => store.id);
  if (!storeIds.length) return [];

  const res = check(
    await supabase
      .from("sync_items")
      .select(
        "id, sync_job_id, store_id, category_root_id, code_folder_name, drive_folder_id, drive_folder_name, shopify_product_id, shopify_product_title, product_status, status, images_found, images_uploaded, images_skipped, images_failed, match_candidates, error_message, updated_at",
      )
      .in("store_id", storeIds)
      .in("status", [...REVIEW_STATUSES])
      .order("updated_at", { ascending: false })
      .limit(limit),
    "review items",
  );
  const names = new Map(stores.map((store) => [store.id, store.name]));
  return (res.data ?? []).map((item) => ({ ...item, store_name: names.get(item.store_id) ?? "Store" }));
}

export async function listActivity(workspaceId: string, limit = 200) {
  const { supabase, stores } = await workspaceStores(workspaceId);
  const names = new Map(stores.map((store) => [store.id, store.name]));
  const res = check(
    await supabase
      .from("activity_logs")
      .select("id, store_id, event_type, message, metadata, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(limit),
    "activity",
  );
  return (res.data ?? []).map((row) => ({
    ...row,
    store_name: row.store_id ? names.get(row.store_id) ?? "Store" : "Workspace",
  }));
}
