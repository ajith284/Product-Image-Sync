import "server-only";

import { randomUUID } from "node:crypto";

import {
  downloadDriveImage as defaultDownload,
  DriveDownloadError,
  loadStoreDriveContext,
  type DriveDownloadDeps,
} from "@/lib/google/download";
import {
  scanCategoryRoots as defaultScan,
  type ScanImage,
  type ScanItem,
  type ScanWarning,
} from "@/lib/google/scan";
import type { ConnectionDeps } from "@/lib/shopify/connection";
import {
  uploadProductImage as defaultUpload,
  type UploadProductImageResult,
} from "@/lib/shopify/media";
import type {
  ImageState,
  SyncJobRepository,
  WorkerProgress,
} from "@/lib/sync/jobs-repository";
import { JobNotFoundError, LostLeaseError } from "@/lib/sync/jobs-repository";
import type { SyncImageRepository } from "@/lib/sync/images-repository";

/**
 * Full sync worker (Prompt 13). One job, one worker:
 *
 *   queued → claim (lease) → running
 *     for each connected CATEGORY root:            (cancellation checked first)
 *       scan  → code folders → PRODUCT folders → image metadata → Shopify match
 *       for each product folder:                    (cancellation checked first)
 *         no_product_found / multiple_matches → review (no download, no upload)
 *         single_match → for each image:            (cancellation checked before image, download, upload)
 *           duplicate check (sync_images) → downloadDriveImage() → uploadProductImage()
 *   → completed | completed_with_errors | cancelled | failed
 *
 * Reuses scanCategoryRoots (Prompt 12), downloadDriveImage (Prompt 11),
 * uploadProductImage + sync_images rules (Prompt 10B). Only the PRODUCT folder name
 * is ever matched to Shopify. dry_run: scan + match + metadata only — no download,
 * no upload, no sync_images writes; the result lists what WOULD happen.
 */

export type WorkerDeps = {
  jobs: SyncJobRepository;
  images: SyncImageRepository;
  google: DriveDownloadDeps;
  shopify: ConnectionDeps;
  scan?: typeof defaultScan;
  download?: typeof defaultDownload;
  upload?: typeof defaultUpload;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newWorkerId?: () => string;
  /** Retries for temporary errors (per operation). */
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  leaseSeconds?: number;
};

export type RunSyncJobInput = {
  jobId: string;
  /** Server-side context (the API key's / session's workspace). Checked against the job in the database. */
  workspaceId: string;
  /** Set when the job was already claimed (e.g. by the n8n run endpoint). */
  workerId?: string;
};

export type RunSyncJobResult =
  | {
      status: "completed" | "completed_with_errors" | "failed" | "cancelled";
      progress: WorkerProgress;
      errorCode: string | null;
    }
  | { status: "not_claimed"; reason: string }
  | { status: "lost_lease"; progress: WorkerProgress };

const MAX_LIST = 100;
const LEASE_SECONDS = 900;
const MAX_IMAGE_ATTEMPTS = 5;

/** Errors that stop the whole job (completed work is kept). */
const STOP_CODES = new Set([
  "STORE_NOT_FOUND",
  "GOOGLE_DRIVE_NOT_CONNECTED",
  "GOOGLE_DRIVE_ROOT_NOT_SELECTED",
  "CATEGORY_ROOT_NOT_CONNECTED",
  "SHOPIFY_NOT_CONNECTED",
  "SHOPIFY_NEEDS_RECONNECT",
  "SHOP_UNAVAILABLE",
  "SCOPE_OR_PERMISSION",
  // Still failing after the bounded retries → Google/Shopify is down: stop safely.
  "GOOGLE_DRIVE_THROTTLED",
  "GOOGLE_DRIVE_UNAVAILABLE",
  "NETWORK_ERROR",
  "TOKEN_REFRESH_UNAVAILABLE",
  "SHOPIFY_THROTTLED",
  "SHOPIFY_UNAVAILABLE",
]);

class StopJob extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(`stop job: ${code}`);
    this.name = "StopJob";
  }
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** Same decision as the SQL sync_image_claim() — used to avoid downloading what won't be uploaded. */
export function predictImageAction(
  state: ImageState | undefined,
  image: { md5Checksum: string | null; modifiedTime: string | null },
  now: number,
  leaseSeconds = LEASE_SECONDS,
  maxAttempts = MAX_IMAGE_ATTEMPTS,
): "upload" | "resume" | "skip" | "busy" | "blocked" {
  if (!state) return "upload";
  const changed =
    image.md5Checksum && state.checksum
      ? image.md5Checksum !== state.checksum
      : image.modifiedTime && state.driveModifiedAt
        ? new Date(image.modifiedTime).getTime() !==
          new Date(state.driveModifiedAt).getTime()
        : false;
  if (state.uploadStatus === "uploaded" && !changed) return "skip";
  if (state.uploadStatus === "processing") return "resume";
  if (
    state.uploadStatus === "pending" &&
    state.lastAttemptAt &&
    new Date(state.lastAttemptAt).getTime() > now - leaseSeconds * 1000
  ) {
    return "busy";
  }
  if (
    state.uploadStatus === "failed" &&
    !changed &&
    (!state.retryable || state.attemptCount >= maxAttempts)
  )
    return "blocked";
  if (state.uploadStatus === "failed" && !changed && state.shopifyMediaId)
    return "resume";
  return "upload";
}

const zero = (): WorkerProgress => ({
  total: 0,
  processed: 0,
  uploaded: 0,
  skipped: 0,
  review: 0,
  failed: 0,
  synced: 0,
  warnings: 0,
  errors: 0,
});

export async function runSyncJob(
  input: RunSyncJobInput,
  deps: WorkerDeps,
): Promise<RunSyncJobResult> {
  const scan = deps.scan ?? defaultScan;
  const download = deps.download ?? defaultDownload;
  const upload = deps.upload ?? defaultUpload;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const lease = deps.leaseSeconds ?? LEASE_SECONDS;
  const attempts = Math.max(1, deps.retry?.attempts ?? 3);
  const baseDelay = deps.retry?.baseDelayMs ?? 2_000;
  const maxDelay = deps.retry?.maxDelayMs ?? 30_000;
  const { workspaceId, jobId } = input;

  // ---- claim (one worker per job) ----
  const workerId =
    input.workerId ?? (deps.newWorkerId ?? (() => `worker-${randomUUID()}`))();
  if (!input.workerId) {
    let claim;
    try {
      claim = await deps.jobs.claim(workspaceId, jobId, workerId, lease);
    } catch (error) {
      if (error instanceof JobNotFoundError)
        return { status: "not_claimed", reason: "job_not_found" };
      throw error;
    }
    if (!claim.claimed) return { status: "not_claimed", reason: claim.reason };
  }

  const progress = zero();
  const plan = {
    would_upload: 0,
    skipped: 0,
    blocked: 0,
    review: 0,
    failed: 0,
  };
  const reviewItems: Record<string, unknown>[] = [];
  const failedItems: Record<string, unknown>[] = [];
  const warnings: ScanWarning[] = [];
  let blocked = 0;

  // The job row decides the store and dry_run — never the caller.
  let hb: Awaited<ReturnType<SyncJobRepository["heartbeat"]>>;
  try {
    hb = await deps.jobs.heartbeat(workspaceId, jobId, workerId);
  } catch (error) {
    if (error instanceof LostLeaseError)
      return { status: "lost_lease", progress };
    if (error instanceof JobNotFoundError)
      return { status: "not_claimed", reason: "job_not_found" };
    throw error;
  }
  const storeId = hb.storeId;
  const dryRun = hb.dryRun;

  const checkpoint = async () => {
    hb = await deps.jobs.heartbeat(workspaceId, jobId, workerId, progress);
    if (hb.cancelRequested) throw new Cancelled();
  };

  /** Bounded retries for temporary errors, honouring Retry-After (capped). */
  async function withRetry<T>(
    op: () => Promise<T>,
    retryAfterOf: (r: T | unknown) => { retry: boolean; afterS?: number },
  ) {
    let last: T | unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        last = await op();
      } catch (error) {
        last = error;
        const d = retryAfterOf(error);
        if (!d.retry || attempt === attempts) throw error;
        await sleep(
          Math.min(
            maxDelay,
            d.afterS ? d.afterS * 1000 : baseDelay * 2 ** (attempt - 1),
          ),
        );
        continue;
      }
      const d = retryAfterOf(last);
      if (!d.retry || attempt === attempts) return last as T;
      await sleep(
        Math.min(
          maxDelay,
          d.afterS ? d.afterS * 1000 : baseDelay * 2 ** (attempt - 1),
        ),
      );
    }
    return last as T;
  }
  const driveRetry = (e: unknown) =>
    e instanceof DriveDownloadError
      ? { retry: e.retryable, afterS: e.retryAfterSeconds }
      : { retry: false };

  const pushLimited = (
    list: Record<string, unknown>[],
    v: Record<string, unknown>,
  ) => {
    if (list.length < MAX_LIST) list.push(v);
  };

  async function processImage(
    item: ScanItem,
    itemId: string,
    productId: string,
    img: ScanImage,
    state: ImageState | undefined,
  ) {
    await checkpoint(); // before image
    const action = predictImageAction(state, img, now(), lease);

    if (dryRun) {
      if (action === "upload" || action === "resume") plan.would_upload += 1;
      else if (action === "blocked") plan.blocked += 1;
      else plan.skipped += 1;
      if (action === "skip" || action === "busy" || action === "blocked")
        progress.skipped += 1;
      return "ok" as const;
    }
    if (action === "skip" || action === "busy") {
      progress.skipped += 1;
      return "ok" as const;
    }
    if (action === "blocked") {
      progress.skipped += 1;
      blocked += 1;
      return "ok" as const;
    }

    // Download (not needed to resume an already-created Shopify media).
    let bytes: Uint8Array = new Uint8Array(0);
    let mimeType = img.mimeType;
    if (action === "upload") {
      await checkpoint(); // before download
      try {
        const file = await withRetry(
          () =>
            download({ workspaceId, storeId, fileId: img.fileId }, deps.google),
          driveRetry,
        );
        bytes = file.buffer;
        mimeType = file.mimeType;
      } catch (error) {
        const e = error instanceof DriveDownloadError ? error : null;
        if (!e || STOP_CODES.has(e.code)) {
          throw new StopJob(
            e?.code ?? "INTERNAL_ERROR",
            e?.publicMessage ?? "The Google Drive download failed.",
          );
        }
        // File-level permanent problem: record it so it isn't retried blindly.
        const claim = await deps.images.claim({
          workspaceId,
          storeId,
          syncItemId: itemId,
          shopifyProductId: productId,
          driveFileId: img.fileId,
          driveFolderId: img.folderId,
          filename: img.filename,
          checksum: img.md5Checksum,
          driveModifiedAt: img.modifiedTime ? new Date(img.modifiedTime) : null,
          mimeType: null,
          fileSize: null,
        });
        if (claim.action === "upload" || claim.action === "resume") {
          const scope = { workspaceId, storeId, imageId: claim.image.id };
          await deps.images.recordAttempt(scope);
          await deps.images.markFailed(scope, {
            code: e.code,
            message: e.publicMessage,
            retryable: e.retryable,
          });
        }
        progress.failed += 1;
        pushLimited(failedItems, {
          product_folder: item.product_folder.name,
          filename: img.filename,
          code: e.code,
        });
        return "failed" as const;
      }
    }

    await checkpoint(); // before upload
    const result = await withRetry<UploadProductImageResult>(
      () =>
        upload(
          {
            workspaceId,
            storeId,
            syncItemId: itemId,
            shopifyProductId: productId,
            driveFileId: img.fileId,
            driveFolderId: img.folderId,
            filename: img.filename,
            mimeType,
            bytes,
            checksum: img.md5Checksum,
            driveModifiedAt: img.modifiedTime
              ? new Date(img.modifiedTime)
              : null,
            dryRun: false,
          },
          { ...deps.shopify, images: deps.images },
        ),
      (r) => {
        const res = r as UploadProductImageResult;
        return res && res.status === "failed" && res.error.retryable
          ? { retry: true, afterS: res.error.retryAfterSeconds }
          : { retry: false };
      },
    );
    if (result.status === "uploaded") {
      progress.uploaded += 1;
      return "ok" as const;
    }
    if (result.status === "skipped") {
      progress.skipped += 1;
      if (result.reason === "permanent_failure") blocked += 1;
      return "ok" as const;
    }
    if (result.status === "failed") {
      if (STOP_CODES.has(result.error.code))
        throw new StopJob(result.error.code, result.error.message);
      progress.failed += 1;
      pushLimited(failedItems, {
        product_folder: item.product_folder.name,
        filename: img.filename,
        code: result.error.code,
      });
      return "failed" as const;
    }
    return "ok" as const;
  }

  async function processItem(item: ScanItem) {
    await checkpoint(); // before product
    const m = item.match;
    const candidates = m.products.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
    }));
    const single = m.outcome === "single_match" ? m.products[0]! : null;
    const itemId = await deps.jobs.recordItem(workspaceId, jobId, workerId, {
      drive_folder_id: item.product_folder.id,
      drive_folder_name: item.product_folder.name,
      category_root_id: item.category_root.id,
      code_folder_id: item.code_folder.id,
      code_folder_name: item.code_folder.name,
      shopify_product_id: single?.id ?? null,
      shopify_product_title: single?.title ?? null,
      product_status: single?.status ?? null,
      status:
        m.outcome === "search_failed"
          ? "skipped"
          : m.outcome === "single_match"
            ? "matched"
            : m.outcome,
      images_found: item.images.length,
      match_candidates: candidates,
      error_message:
        m.outcome === "search_failed"
          ? `${m.error.code}: ${m.error.message}`
          : null,
    });

    if (m.outcome === "no_product_found" || m.outcome === "multiple_matches") {
      // Review — never download, never upload, never pick a product.
      progress.review += 1;
      plan.review += 1;
      progress.processed += 1;
      pushLimited(reviewItems, {
        category_root: item.category_root.name,
        code_folder: item.code_folder.name,
        product_folder: item.product_folder.name,
        outcome: m.outcome,
        candidates,
        images: item.images.length,
      });
      return;
    }
    if (m.outcome === "search_failed") {
      // A revoked / uninstalled Shopify app makes every later search fail the same way.
      if (
        m.error.code === "SHOPIFY_UNAUTHORIZED" ||
        m.error.code === "SHOPIFY_NOT_FOUND"
      ) {
        throw new StopJob(
          "SHOPIFY_NEEDS_RECONNECT",
          "Shopify needs to be reconnected.",
        );
      }
      progress.failed += 1;
      progress.errors += 1;
      plan.failed += 1;
      progress.processed += 1;
      pushLimited(failedItems, {
        product_folder: item.product_folder.name,
        code: m.error.code,
      });
      return;
    }

    const productId = single!.id;
    const states = await deps.jobs.imageStates(
      storeId,
      productId,
      item.images.map((i) => i.fileId),
    );
    const byFile = new Map(states.map((s) => [s.driveFileId, s]));
    const before = { ...progress };
    let itemFailed = 0;
    for (const img of item.images) {
      if (
        (await processImage(
          item,
          itemId,
          productId,
          img,
          byFile.get(img.fileId),
        )) === "failed"
      )
        itemFailed += 1;
    }
    progress.processed += 1;
    if (!dryRun) {
      if (itemFailed === 0) progress.synced += 1;
      await deps.jobs.updateItem({
        workspaceId,
        jobId,
        workerId,
        itemId,
        status: itemFailed ? "upload_failed" : "synced",
        uploaded: progress.uploaded - before.uploaded,
        skipped: progress.skipped - before.skipped,
        failed: itemFailed,
        errorMessage: itemFailed ? `${itemFailed} image(s) failed.` : null,
      });
    }
  }

  const result = () => ({
    dry_run: dryRun,
    ...(dryRun ? { plan } : {}),
    products: progress.total,
    processed: progress.processed,
    uploaded: progress.uploaded,
    skipped: progress.skipped,
    blocked: dryRun ? plan.blocked : blocked,
    review: progress.review,
    failed: progress.failed,
    review_items: reviewItems,
    failed_items: failedItems,
    warnings: warnings
      .slice(0, MAX_LIST)
      .map((w) => ({
        type: w.type,
        folder: w.folder_name ?? null,
        detail: w.detail ?? null,
      })),
  });

  const finish = async (
    status: "completed" | "completed_with_errors" | "failed" | "cancelled",
    code: string | null,
    message: string | null,
  ) => {
    progress.warnings = warnings.length;
    await deps.jobs.finish({
      workspaceId,
      jobId,
      workerId,
      status,
      errorCode: code,
      errorMessage: message,
      progress,
      result: result(),
    });
    return { status, progress, errorCode: code } as const;
  };

  try {
    // workspace → store → Google connection → category roots (re-checked by every service as well).
    const ctx = await loadStoreDriveContext(
      { workspaceId, storeId },
      deps.google,
    );
    for (const root of ctx.roots) {
      await checkpoint(); // before root
      const scanned = await withRetry(
        () =>
          scan(
            { workspaceId, storeId, categoryRootIds: [root.id] },
            { google: deps.google, shopify: deps.shopify },
          ),
        driveRetry,
      );
      warnings.push(...scanned.warnings);
      progress.total += scanned.items.length;
      progress.warnings = warnings.length;
      for (const item of scanned.items) await processItem(item);
    }
    await checkpoint();
    return await finish(
      progress.failed > 0 ? "completed_with_errors" : "completed",
      null,
      null,
    );
  } catch (error) {
    if (error instanceof LostLeaseError)
      return { status: "lost_lease", progress };
    if (error instanceof Cancelled) return finish("cancelled", null, null);
    if (error instanceof StopJob) {
      progress.errors += 1;
      return finish("failed", error.code, error.publicMessage);
    }
    if (error instanceof DriveDownloadError) {
      progress.errors += 1;
      return finish("failed", error.code, error.publicMessage);
    }
    progress.errors += 1;
    console.error(
      `[sync-worker] unexpected ${error instanceof Error ? error.name : "error"}`,
    );
    try {
      return await finish(
        "failed",
        "INTERNAL_ERROR",
        "The sync stopped because of an unexpected error.",
      );
    } catch (finishError) {
      if (finishError instanceof LostLeaseError)
        return { status: "lost_lease", progress };
      throw finishError;
    }
  }
}
