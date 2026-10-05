import "server-only";

import { redirect } from "next/navigation";
import { z } from "zod";

import { isSessionError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";

/** All queries run as the signed-in user, so RLS applies on top of the explicit workspace filter. */

function check<T extends { error: { code?: string; message?: string } | null }>(res: T, what: string): T {
  if (res.error) {
    if (isSessionError(res.error)) redirect("/login?reason=expired");
    throw new Error(`Could not load ${what}`);
  }
  return res;
}

export async function listStores(workspaceId: string) {
  const supabase = await createClient();
  const res = check(
    await supabase
      .from("stores")
      .select("id, name, shopify_domain, status, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }),
    "stores",
  );
  return res.data ?? [];
}

export async function getDashboardStats(workspaceId: string) {
  const stores = await listStores(workspaceId);
  const storeIds = stores.map((s) => s.id);
  const connectedStores = stores.filter((s) => s.status === "connected").length;

  if (storeIds.length === 0) {
    return { stores, connectedStores, productsSynced: 0, imagesUploaded: 0, needsReview: 0 };
  }

  const supabase = await createClient();
  const jobs = check(
    await supabase
      .from("sync_jobs")
      .select(
        "id, store_id, dry_run, status, created_at, products_synced, images_uploaded, items_review, items_failed",
      )
      .in("store_id", storeIds)
      .eq("dry_run", false)
      .order("created_at", { ascending: false })
      .limit(1000),
    "sync jobs",
  );

  // Dashboard counters represent the latest real sync for each store.
  // Do not count the all-time sync_items / sync_images ledger because that
  // makes the dashboard grow forever and keeps old test-run numbers visible.
  const latestByStore = new Map<
    string,
    NonNullable<typeof jobs.data>[number]
  >();

  for (const job of jobs.data ?? []) {
    if (!latestByStore.has(job.store_id)) latestByStore.set(job.store_id, job);
  }

  let productsSynced = 0;
  let imagesUploaded = 0;
  let needsReview = 0;

  for (const job of latestByStore.values()) {
    productsSynced += job.products_synced ?? 0;
    imagesUploaded += job.images_uploaded ?? 0;
    needsReview += (job.items_review ?? 0) + (job.items_failed ?? 0);
  }

  return {
    stores,
    connectedStores,
    productsSynced,
    imagesUploaded,
    needsReview,
  };
}

/** Returns null when the id is invalid, not visible (RLS), or in another workspace. */
export async function getStoreDetails(workspaceId: string, storeId: string) {
  if (!z.uuid().safeParse(storeId).success) return null;
  const supabase = await createClient();

  const storeRes = check(
    await supabase
      .from("stores")
      .select("id, name, shopify_domain, status, created_at, updated_at")
      .eq("id", storeId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    "store",
  );
  if (!storeRes.data) return null;

  const [shopify, drive, jobs, roots] = await Promise.all([
    supabase
      .from("shopify_connections")
      .select("connection_status, shop_domain, installed_at, last_verified_at, last_error, refresh_token_expires_at, disconnected_at")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabase
      .from("google_drive_connections")
      .select("connection_status, google_account_id, google_account_email, root_folder_name, connected_at, last_verified_at, last_error, disconnected_at")
      .eq("store_id", storeId)
      .maybeSingle(),
    supabase
      .from("sync_jobs")
      .select(
        "id, status, trigger_type, dry_run, started_at, completed_at, products_processed, products_synced, images_uploaded, items_total, items_skipped, items_review, items_failed, errors_count, error_code, error_message, created_at",
      )
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("google_drive_category_roots")
      .select("folder_id, folder_name, google_account_id, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: true }),
  ]);
  check(shopify, "Shopify connection");
  check(drive, "Google Drive connection");
  check(jobs, "sync jobs");
  check(roots, "Google Drive category folders");

  // Only folders selected with the currently connected Google account count.
  const accountId = drive.data?.google_account_id ?? null;
  const categoryRoots = (roots.data ?? [])
    .filter((r) => accountId && r.google_account_id === accountId)
    .map((r) => ({ id: r.folder_id, name: r.folder_name }));

  return {
    store: storeRes.data,
    shopify: shopify.data,
    // google_account_id is only used for the filter above; it never reaches the browser.
    drive: drive.data ? { ...withoutAccountId(drive.data), category_roots: categoryRoots } : null,
    jobs: jobs.data ?? [],
  };
}

function withoutAccountId<T extends { google_account_id?: unknown }>(row: T): Omit<T, "google_account_id"> {
  const copy = { ...row };
  delete copy.google_account_id;
  return copy;
}

export async function listMembers(workspaceId: string) {
  const supabase = await createClient();
  const members = check(
    await supabase
      .from("workspace_members")
      .select("user_id, role, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true }),
    "members",
  ).data ?? [];

  const ids = members.map((m) => m.user_id);
  const profiles = ids.length
    ? check(await supabase.from("profiles").select("id, full_name").in("id", ids), "profiles").data ?? []
    : [];
  const names = new Map(profiles.map((p) => [p.id, p.full_name]));
  return members.map((m) => ({ ...m, fullName: names.get(m.user_id) ?? null }));
}
