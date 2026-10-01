import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Worker data access (supabase/migrations/20261001220000_sync_worker.sql).
 * Every call is a service-role-only function that re-checks workspace â†’ job
 * (â†’ worker lease) itself; nothing here trusts the caller's IDs on their own.
 */

export type WorkerProgress = {
  total: number; // product folders found
  processed: number; // product folders handled
  uploaded: number; // images uploaded (0 in dry run)
  skipped: number; // images skipped (already uploaded / in progress / blocked)
  review: number; // product folders needing review (no / multiple matches)
  failed: number; // images (or product searches) that failed
  synced: number; // product folders fully synced
  warnings: number;
  errors: number;
};

export type ClaimResult = {
  claimed: boolean;
  reason: "claimed" | "reclaimed" | "already_running" | "finished";
  job: {
    job_id: string;
    store_id: string;
    status: string;
    dry_run: boolean;
    options: Record<string, unknown>;
  } & Record<string, unknown>;
};

export type ItemRecord = {
  drive_folder_id: string;
  drive_folder_name: string;
  category_root_id: string;
  code_folder_id: string;
  code_folder_name: string;
  shopify_product_id: string | null;
  shopify_product_title: string | null;
  product_status: string | null;
  status: "matched" | "no_product_found" | "multiple_matches" | "skipped";
  images_found: number;
  match_candidates: { id: string; title: string; status: string }[];
  error_message: string | null;
};

export type ImageState = {
  driveFileId: string;
  uploadStatus: string;
  checksum: string | null;
  driveModifiedAt: string | null;
  shopifyMediaId: string | null;
  retryable: boolean | null;
  attemptCount: number;
  lastAttemptAt: string | null;
};

/** Another worker took the job over (lease expired) or the job is no longer running. */
export class LostLeaseError extends Error {
  constructor() {
    super("sync job lease lost");
    this.name = "LostLeaseError";
  }
}

export class JobNotFoundError extends Error {
  constructor() {
    super("sync job not found");
    this.name = "JobNotFoundError";
  }
}

export interface SyncJobRepository {
  claim(
    workspaceId: string,
    jobId: string,
    workerId: string,
    leaseSeconds?: number,
  ): Promise<ClaimResult>;
  heartbeat(
    workspaceId: string,
    jobId: string,
    workerId: string,
    progress?: Partial<WorkerProgress>,
  ): Promise<{ cancelRequested: boolean; storeId: string; dryRun: boolean }>;
  finish(input: {
    workspaceId: string;
    jobId: string;
    workerId: string;
    status: "completed" | "completed_with_errors" | "failed" | "cancelled";
    errorCode: string | null;
    errorMessage: string | null;
    progress: WorkerProgress;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  recordItem(
    workspaceId: string,
    jobId: string,
    workerId: string,
    item: ItemRecord,
  ): Promise<string>;
  updateItem(input: {
    workspaceId: string;
    jobId: string;
    workerId: string;
    itemId: string;
    status: "synced" | "upload_failed" | "matched" | "skipped";
    uploaded: number;
    skipped: number;
    failed: number;
    errorMessage: string | null;
  }): Promise<void>;
  /** sync_images rows for one product (read-only; used for dry-run plans and to avoid needless downloads). */
  imageStates(
    storeId: string,
    shopifyProductId: string,
    driveFileIds: string[],
  ): Promise<ImageState[]>;
}

function fail(error: { message?: string } | null): never {
  const code = error?.message?.trim();
  if (code === "job_not_owned") throw new LostLeaseError();
  if (code === "job_not_found") throw new JobNotFoundError();
  throw new Error(
    `sync job update failed${code && /^[a-z_]{3,40}$/.test(code) ? ` (${code})` : ""}`,
  );
}

function rpcNullableText(value: string | null): string {
  return value as unknown as string;
}
export function createSyncJobRepository(): SyncJobRepository {
  const db = createAdminClient();
  return {
    async claim(workspaceId, jobId, workerId, leaseSeconds = 900) {
      const { data, error } = await db.rpc("sync_job_claim", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
      if (error) fail(error);
      const row = data?.[0];
      if (!row) throw new JobNotFoundError();
      return {
        claimed: row.claimed === true,
        reason: row.reason as ClaimResult["reason"],
        job: row.job as ClaimResult["job"],
      };
    },
    async heartbeat(workspaceId, jobId, workerId, progress) {
      const { data, error } = await db.rpc("sync_job_heartbeat", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_worker_id: workerId,
        p_progress: (progress ?? null) as Json,
      });
      if (error) fail(error);
      const j = data as {
        cancel_requested: boolean;
        store_id: string;
        dry_run: boolean;
      };
      return {
        cancelRequested: j.cancel_requested === true,
        storeId: j.store_id,
        dryRun: j.dry_run === true,
      };
    },
    async finish(i) {
      const { data, error } = await db.rpc("sync_job_finish", {
        p_workspace_id: i.workspaceId,
        p_job_id: i.jobId,
        p_worker_id: i.workerId,
        p_status: i.status,
        p_error_code: rpcNullableText(i.errorCode),
        p_error_message: rpcNullableText(i.errorMessage),
        p_progress: i.progress as unknown as Json,
        p_result: i.result as Json,
      });
      if (error) fail(error);
      return data as Record<string, unknown>;
    },
    async recordItem(workspaceId, jobId, workerId, item) {
      const { data, error } = await db.rpc("sync_item_record", {
        p_workspace_id: workspaceId,
        p_job_id: jobId,
        p_worker_id: workerId,
        p_item: item as unknown as Json,
      });
      if (error) fail(error);
      return data as string;
    },
    async updateItem(i) {
      const { error } = await db.rpc("sync_item_update", {
        p_workspace_id: i.workspaceId,
        p_job_id: i.jobId,
        p_worker_id: i.workerId,
        p_item_id: i.itemId,
        p_status: i.status,
        p_images_uploaded: i.uploaded,
        p_images_skipped: i.skipped,
        p_images_failed: i.failed,
        p_error_message: rpcNullableText(i.errorMessage),
      });
      if (error) fail(error);
    },
    async imageStates(storeId, shopifyProductId, driveFileIds) {
      if (!driveFileIds.length) return [];
      const { data, error } = await db
        .from("sync_images")
        .select(
          "drive_file_id, upload_status, checksum, drive_modified_at, shopify_media_id, retryable, attempt_count, last_attempt_at",
        )
        .eq("store_id", storeId)
        .eq("shopify_product_id", shopifyProductId)
        .in("drive_file_id", driveFileIds);
      if (error) throw new Error("Could not read image states");
      return (data ?? []).map((r) => ({
        driveFileId: r.drive_file_id,
        uploadStatus: r.upload_status,
        checksum: r.checksum,
        driveModifiedAt: r.drive_modified_at,
        shopifyMediaId: r.shopify_media_id,
        retryable: r.retryable,
        attemptCount: r.attempt_count,
        lastAttemptAt: r.last_attempt_at,
      }));
    },
  };
}

