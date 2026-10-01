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

const REVIEW_STATUSES = ["no_product_found", "multiple_matches", "upload_failed"];

export async function getDashboardStats(workspaceId: string) {
  const stores = await listStores(workspaceId);
  const storeIds = stores.map((s) => s.id);
  const connectedStores = stores.filter((s) => s.status === "connected").length;

  if (storeIds.length === 0) {
    return { stores, connectedStores, productsSynced: 0, imagesUploaded: 0, needsReview: 0 };
  }

  const supabase = await createClient();
  const [synced, images, review] = await Promise.all([
    supabase.from("sync_items").select("id", { count: "exact", head: true }).in("store_id", storeIds).eq("status", "synced"),
    supabase.from("sync_images").select("id", { count: "exact", head: true }).in("store_id", storeIds).eq("upload_status", "uploaded"),
    supabase.from("sync_items").select("id", { count: "exact", head: true }).in("store_id", storeIds).in("status", REVIEW_STATUSES),
  ]);
  check(synced, "sync items");
  check(images, "images");
  check(review, "review items");

  return {
    stores,
    connectedStores,
    productsSynced: synced.count ?? 0,
    imagesUploaded: images.count ?? 0,
    needsReview: review.count ?? 0,
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
      .select("id, status, trigger_type, started_at, completed_at, products_processed, images_uploaded, errors_count, created_at")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(5),
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
