import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Upload ledger (public.sync_images) through the service-role-only sync_image_*
 * functions (supabase/migrations/20261001200000_sync_images_upload.sql). Each
 * function re-checks workspace → store → sync item / image itself, so a caller
 * can never touch another workspace's or store's records.
 */

export type ClaimAction = "upload" | "resume" | "skip" | "busy" | "blocked";

export type SyncImageRecord = {
  id: string;
  storeId: string;
  shopifyProductId: string;
  driveFileId: string;
  shopifyMediaId: string | null;
  uploadStatus: "pending" | "processing" | "uploaded" | "failed" | "skipped";
  errorCode: string | null;
  retryable: boolean | null;
  attemptCount: number;
};

export type ClaimInput = {
  workspaceId: string;
  storeId: string;
  syncItemId: string | null;
  shopifyProductId: string;
  driveFileId: string;
  driveFolderId: string | null;
  filename: string;
  checksum: string | null;
  driveModifiedAt: Date | null;
  mimeType: string | null;
  fileSize: number | null;
};

type Scope = { workspaceId: string; storeId: string; imageId: string };

export interface SyncImageRepository {
  claim(input: ClaimInput): Promise<{ action: ClaimAction; image: SyncImageRecord }>;
  recordAttempt(scope: Scope): Promise<SyncImageRecord>;
  markProcessing(scope: Scope, shopifyMediaId: string): Promise<SyncImageRecord>;
  markUploaded(scope: Scope, shopifyMediaId: string): Promise<SyncImageRecord>;
  /**
   * Shopify no longer has the previously uploaded media attached to this product.
   * Reset the ledger row so the unchanged Drive file can be uploaded again.
   */
  resetMissing(input: {
    workspaceId: string;
    storeId: string;
    shopifyProductId: string;
    driveFileId: string;
  }): Promise<SyncImageRecord>;
  markFailed(scope: Scope, error: { code: string; message: string; retryable: boolean }): Promise<SyncImageRecord>;
}

/** store / sync item / image doesn't belong to the given workspace/store. */
export class SyncImageAccessError extends Error {
  readonly code: "store_not_found" | "sync_item_not_found" | "image_not_found";
  constructor(code: SyncImageAccessError["code"]) {
    super(`sync image access: ${code}`);
    this.name = "SyncImageAccessError";
    this.code = code;
  }
}

const ACCESS_CODES = new Set(["store_not_found", "sync_item_not_found", "image_not_found"]);

type Json = Record<string, unknown>;

export function toSyncImageRecord(j: Json): SyncImageRecord {
  return {
    id: String(j.id),
    storeId: String(j.store_id),
    shopifyProductId: String(j.shopify_product_id),
    driveFileId: String(j.drive_file_id),
    shopifyMediaId: (j.shopify_media_id as string | null) ?? null,
    uploadStatus: j.upload_status as SyncImageRecord["uploadStatus"],
    errorCode: (j.error_code as string | null) ?? null,
    retryable: (j.retryable as boolean | null) ?? null,
    attemptCount: Number(j.attempt_count ?? 0),
  };
}

function fail(error: { message?: string } | null): never {
  const code = error?.message?.trim() ?? "";
  if (ACCESS_CODES.has(code)) throw new SyncImageAccessError(code as SyncImageAccessError["code"]);
  // Never surface raw database errors.
  throw new Error(`sync_images update failed${/^[a-z_]{3,40}$/.test(code) ? ` (${code})` : ""}`);
}

export function createSyncImageRepository(): SyncImageRepository {
  const db = createAdminClient();
  return {
    async claim(i) {
      const { data, error } = await db.rpc("sync_image_claim", {
        p_workspace_id: i.workspaceId,
        p_store_id: i.storeId,
        p_sync_item_id: i.syncItemId ?? undefined,
        p_shopify_product_id: i.shopifyProductId,
        p_drive_file_id: i.driveFileId,
        p_drive_folder_id: i.driveFolderId ?? undefined,
        p_filename: i.filename,
        p_checksum: i.checksum ?? undefined,
        p_drive_modified_at: i.driveModifiedAt ? i.driveModifiedAt.toISOString() : undefined,
        p_mime_type: i.mimeType ?? undefined,
        p_file_size: i.fileSize ?? undefined,
      });
      if (error || !data) fail(error);
      const j = data as { action: ClaimAction; image: Json };
      return { action: j.action, image: toSyncImageRecord(j.image) };
    },
    async recordAttempt(s) {
      const { data, error } = await db.rpc("sync_image_record_attempt", {
        p_workspace_id: s.workspaceId,
        p_store_id: s.storeId,
        p_image_id: s.imageId,
      });
      if (error || !data) fail(error);
      return toSyncImageRecord(data as Json);
    },
    async markProcessing(s, mediaId) {
      const { data, error } = await db.rpc("sync_image_mark_processing", {
        p_workspace_id: s.workspaceId,
        p_store_id: s.storeId,
        p_image_id: s.imageId,
        p_shopify_media_id: mediaId,
      });
      if (error || !data) fail(error);
      return toSyncImageRecord(data as Json);
    },
    async markUploaded(s, mediaId) {
      const { data, error } = await db.rpc("sync_image_mark_uploaded", {
        p_workspace_id: s.workspaceId,
        p_store_id: s.storeId,
        p_image_id: s.imageId,
        p_shopify_media_id: mediaId,
      });
      if (error || !data) fail(error);
      return toSyncImageRecord(data as Json);
    },
    async resetMissing(i) {
      // This repository uses the service-role client, so re-check workspace → store
      // before mutating a ledger row. Never trust the caller's store ID alone.
      const { data: store, error: storeError } = await db
        .from("stores")
        .select("id")
        .eq("id", i.storeId)
        .eq("workspace_id", i.workspaceId)
        .maybeSingle();
      if (storeError || !store) throw new SyncImageAccessError("store_not_found");

      const { data, error } = await db
        .from("sync_images")
        .update({
          upload_status: "pending",
          shopify_media_id: null,
          uploaded_at: null,
          error_code: null,
          error_message: null,
          retryable: null,
          attempt_count: 0,
          last_attempt_at: null,
        })
        .eq("store_id", i.storeId)
        .eq("shopify_product_id", i.shopifyProductId)
        .eq("drive_file_id", i.driveFileId)
        .select(
          "id, store_id, shopify_product_id, drive_file_id, shopify_media_id, upload_status, error_code, retryable, attempt_count",
        )
        .maybeSingle();
      if (error || !data) throw new SyncImageAccessError("image_not_found");
      return toSyncImageRecord(data as Json);
    },
    async markFailed(s, e) {
      const { data, error } = await db.rpc("sync_image_mark_failed", {
        p_workspace_id: s.workspaceId,
        p_store_id: s.storeId,
        p_image_id: s.imageId,
        p_error_code: e.code,
        p_error_message: e.message,
        p_retryable: e.retryable,
      });
      if (error || !data) fail(error);
      return toSyncImageRecord(data as Json);
    },
  };
}
