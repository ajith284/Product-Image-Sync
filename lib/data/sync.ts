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


export type SyncStoreOverviewStatus =
  | "completed"
  | "in_progress"
  | "skipped"
  | "review"
  | "failed";

export type SyncStoreOverviewItem = {
  store_id: string;
  store_name: string;
  shopify_domain: string | null;
  store_status: string;
  sync_status: SyncStoreOverviewStatus;
  job_id: string | null;
  job_status: string | null;
  dry_run: boolean;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  products_processed: number;
  products_synced: number;
  images_uploaded: number;
  items_skipped: number;
  items_review: number;
  items_failed: number;
  error_message: string | null;
};

function overviewStatus(job: {
  status: string;
  products_processed: number;
  items_skipped: number;
  items_review: number;
  items_failed: number;
} | null): SyncStoreOverviewStatus {
  if (!job) return "skipped";
  if (job.status === "queued" || job.status === "running") return "in_progress";
  if (job.status === "failed" || job.items_failed > 0) return "failed";
  if (job.items_review > 0) return "review";
  if (job.status === "cancelled" || (job.products_processed === 0 && job.items_skipped > 0)) {
    return "skipped";
  }
  return "completed";
}

/**
 * One row per store for the Sync Jobs overview. The newest sync job is used
 * for the store's metrics/status; stores with no history still remain visible.
 */
export async function listSyncStoreOverview(
  workspaceId: string,
): Promise<SyncStoreOverviewItem[]> {
  const { supabase, stores } = await workspaceStores(workspaceId);
  if (!stores.length) return [];

  const storeIds = stores.map((store) => store.id);
  const jobsRes = check(
    await supabase
      .from("sync_jobs")
      .select(
        "id, store_id, status, dry_run, created_at, started_at, completed_at, products_processed, products_synced, images_uploaded, items_skipped, items_review, items_failed, error_message",
      )
      .in("store_id", storeIds)
      .order("created_at", { ascending: false })
      .limit(1000),
    "sync jobs",
  );

  const latest = new Map<string, NonNullable<typeof jobsRes.data>[number]>();
  for (const job of jobsRes.data ?? []) {
    if (!latest.has(job.store_id)) latest.set(job.store_id, job);
  }

  return stores.map((store) => {
    const job = latest.get(store.id) ?? null;
    return {
      store_id: store.id,
      store_name: store.name,
      shopify_domain: store.shopify_domain,
      store_status: store.status,
      sync_status: overviewStatus(job),
      job_id: job?.id ?? null,
      job_status: job?.status ?? null,
      dry_run: job?.dry_run ?? false,
      created_at: job?.created_at ?? null,
      started_at: job?.started_at ?? null,
      completed_at: job?.completed_at ?? null,
      products_processed: job?.products_processed ?? 0,
      products_synced: job?.products_synced ?? 0,
      images_uploaded: job?.images_uploaded ?? 0,
      items_skipped: job?.items_skipped ?? 0,
      items_review: job?.items_review ?? 0,
      items_failed: job?.items_failed ?? 0,
      error_message: job?.error_message ?? null,
    };
  });
}


export type ProductReviewStatus =
  | "completed"
  | "no_product_found"
  | "multiple_matches"
  | "upload_failed"
  | "skipped"
  | "other";

export type ProductReviewItem = {
  id: string;
  sync_job_id: string;
  store_id: string;
  store_name: string;
  category_root_id: string | null;
  category_name: string;
  code_folder_name: string | null;
  drive_folder_id: string;
  drive_folder_name: string | null;
  shopify_product_id: string | null;
  shopify_product_title: string | null;
  product_status: string | null;
  raw_status: string;
  review_status: ProductReviewStatus;
  images_found: number;
  images_uploaded: number;
  images_skipped: number;
  images_failed: number;
  error_message: string | null;
  updated_at: string;
};

function productReviewStatus(status: string): ProductReviewStatus {
  if (status === "synced") return "completed";
  if (status === "no_product_found") return "no_product_found";
  if (status === "multiple_matches") return "multiple_matches";
  if (status === "upload_failed") return "upload_failed";
  if (status === "skipped") return "skipped";
  return "other";
}

/**
 * Product-level sync history for the Review page.
 *
 * We keep one latest row per store + Drive product folder, so repeated syncs do
 * not produce duplicate products. Successful products are included alongside
 * review/failure statuses.
 */
export async function listProductReviewItems(
  workspaceId: string,
  maxRows = 5000,
): Promise<ProductReviewItem[]> {
  const { supabase, stores } = await workspaceStores(workspaceId);
  const storeIds = stores.map((store) => store.id);
  if (!storeIds.length) return [];

  const rows: {
    id: string;
    sync_job_id: string;
    store_id: string;
    category_root_id: string | null;
    code_folder_name: string | null;
    drive_folder_id: string;
    drive_folder_name: string | null;
    shopify_product_id: string | null;
    shopify_product_title: string | null;
    product_status: string | null;
    status: string;
    images_found: number;
    images_uploaded: number;
    images_skipped: number;
    images_failed: number;
    error_message: string | null;
    updated_at: string;
  }[] = [];

  const pageSize = 1000;
  for (let from = 0; from < maxRows; from += pageSize) {
    const to = Math.min(from + pageSize - 1, maxRows - 1);
    const res = check(
      await supabase
        .from("sync_items")
        .select(
          "id, sync_job_id, store_id, category_root_id, code_folder_name, drive_folder_id, drive_folder_name, shopify_product_id, shopify_product_title, product_status, status, images_found, images_uploaded, images_skipped, images_failed, error_message, updated_at",
        )
        .in("store_id", storeIds)
        .order("updated_at", { ascending: false })
        .range(from, to),
      "product sync items",
    );
    const page = res.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  const categoryIds = [
    ...new Set(
      rows
        .map((row) => row.category_root_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const rootsRes = categoryIds.length
    ? check(
        await supabase
          .from("google_drive_category_roots")
          .select("store_id, folder_id, folder_name")
          .in("store_id", storeIds)
          .in("folder_id", categoryIds),
        "category folders",
      )
    : { data: [] as { store_id: string; folder_id: string; folder_name: string }[], error: null };

  const categoryNames = new Map(
    (rootsRes.data ?? []).map((root) => [
      `${root.store_id}:${root.folder_id}`,
      root.folder_name,
    ]),
  );
  const storeNames = new Map(stores.map((store) => [store.id, store.name]));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.store_id}:${row.drive_folder_id}`;
    if (!latest.has(key)) latest.set(key, row);
  }

  return [...latest.values()].map((row) => ({
    id: row.id,
    sync_job_id: row.sync_job_id,
    store_id: row.store_id,
    store_name: storeNames.get(row.store_id) ?? "Store",
    category_root_id: row.category_root_id,
    category_name:
      (row.category_root_id
        ? categoryNames.get(`${row.store_id}:${row.category_root_id}`)
        : null) ??
      row.code_folder_name ??
      "Uncategorized",
    code_folder_name: row.code_folder_name,
    drive_folder_id: row.drive_folder_id,
    drive_folder_name: row.drive_folder_name,
    shopify_product_id: row.shopify_product_id,
    shopify_product_title: row.shopify_product_title,
    product_status: row.product_status,
    raw_status: row.status,
    review_status: productReviewStatus(row.status),
    images_found: row.images_found,
    images_uploaded: row.images_uploaded,
    images_skipped: row.images_skipped,
    images_failed: row.images_failed,
    error_message: row.error_message,
    updated_at: row.updated_at,
  }));
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
