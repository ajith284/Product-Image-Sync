import { vi } from "vitest";

import type { StoreDriveContext } from "@/lib/google/download";
import type { ScanImage, ScanItem, ScanResult } from "@/lib/google/scan";
import type {
  UploadProductImageInput,
  UploadProductImageResult,
} from "@/lib/shopify/media";
import type {
  ClaimAction,
  ClaimInput,
  SyncImageRecord,
  SyncImageRepository,
} from "@/lib/sync/images-repository";
import {
  JobNotFoundError,
  LostLeaseError,
  type ClaimResult,
  type ImageState,
  type ItemRecord,
  type SyncJobRepository,
  type WorkerProgress,
} from "@/lib/sync/jobs-repository";
import type { WorkerDeps } from "@/lib/sync/worker";

export const W_WS = "2d12febb-95b9-41dd-8d01-e721af3bac2c";
export const W_STORE = "7bb362f0-ce91-4b0b-a81b-373d49f2b242";
export const W_OTHER_WS = "99999999-9999-4999-8999-999999999999";
export const W_OTHER_STORE = "88888888-8888-4888-8888-888888888888";
export const W_JOB = "11111111-1111-4111-8111-111111111111";
export const SOFA = "rootSofaImage001";
export const SOFA_BED = "rootSofaBedImg01";
export const T0 = 1_790_000_000_000;

type JobRow = {
  id: string;
  workspace_id: string;
  store_id: string;
  status: string;
  dry_run: boolean;
  cancel_requested: boolean;
  worker_id: string | null;
  heartbeat_at: number | null;
  progress: Partial<WorkerProgress>;
  result: Record<string, unknown> | null;
  error_code: string | null;
};
type ItemRow = ItemRecord & {
  id: string;
  job: string;
  uploaded?: number;
  skipped?: number;
  failed?: number;
  final?: string;
};
type ImageRow = SyncImageRecord & {
  checksum: string | null;
  driveModifiedAt: string | null;
  filename: string;
  lastAttemptAt: number | null;
};

/**
 * In-memory mirror of supabase/migrations/20261001220000_sync_worker.sql (claim / lease /
 * heartbeat / finish / items) and 20261001200000_sync_images_upload.sql (sync_image_claim).
 */
export function fakeWorkerDb(clock: { now: number }) {
  const jobs = new Map<string, JobRow>();
  const items: ItemRow[] = [];
  const images: ImageRow[] = [];
  const heartbeats: Partial<WorkerProgress>[] = [];
  let seq = 0;

  const addJob = (o: Partial<JobRow> = {}) => {
    const j: JobRow = {
      id: W_JOB,
      workspace_id: W_WS,
      store_id: W_STORE,
      status: "queued",
      dry_run: false,
      cancel_requested: false,
      worker_id: null,
      heartbeat_at: null,
      progress: {},
      result: null,
      error_code: null,
      ...o,
    };
    jobs.set(j.id, j);
    return j;
  };

  const owned = (ws: string, id: string, worker: string) => {
    const j = jobs.get(id);
    if (!j || j.workspace_id !== ws) throw new JobNotFoundError();
    if (j.status !== "running" || j.worker_id !== worker)
      throw new LostLeaseError();
    return j;
  };

  const jobs_: SyncJobRepository = {
    claim: vi.fn(
      async (
        ws: string,
        id: string,
        worker: string,
        leaseSeconds = 900,
      ): Promise<ClaimResult> => {
        const j = jobs.get(id);
        if (!j || j.workspace_id !== ws) throw new JobNotFoundError();
        const view = {
          job_id: j.id,
          store_id: j.store_id,
          status: j.status,
          dry_run: j.dry_run,
          options: {},
        };
        if (j.status === "queued") {
          Object.assign(j, {
            status: "running",
            worker_id: worker,
            heartbeat_at: clock.now,
          });
          return {
            claimed: true,
            reason: "claimed",
            job: { ...view, status: "running" },
          };
        }
        if (j.status === "running") {
          if ((j.heartbeat_at ?? 0) < clock.now - leaseSeconds * 1000) {
            Object.assign(j, { worker_id: worker, heartbeat_at: clock.now });
            return { claimed: true, reason: "reclaimed", job: view };
          }
          return { claimed: false, reason: "already_running", job: view };
        }
        return { claimed: false, reason: "finished", job: view };
      },
    ),
    heartbeat: vi.fn(
      async (
        ws: string,
        id: string,
        worker: string,
        progress?: Partial<WorkerProgress>,
      ) => {
        const j = owned(ws, id, worker);
        j.heartbeat_at = clock.now;
        if (progress) {
          j.progress = { ...progress };
          heartbeats.push({ ...progress });
        }
        return {
          cancelRequested: j.cancel_requested,
          storeId: j.store_id,
          dryRun: j.dry_run,
        };
      },
    ),
    finish: vi.fn(async (i) => {
      const j = owned(i.workspaceId, i.jobId, i.workerId);
      Object.assign(j, {
        status: i.status,
        error_code: i.errorCode,
        progress: { ...i.progress },
        result: i.result,
        worker_id: null,
      });
      return { job_id: j.id, status: j.status };
    }),
    recordItem: vi.fn(
      async (ws: string, id: string, worker: string, item: ItemRecord) => {
        owned(ws, id, worker);
        const existing = items.find(
          (x) => x.job === id && x.drive_folder_id === item.drive_folder_id,
        );
        if (existing) {
          Object.assign(existing, item);
          return existing.id;
        }
        const row = { ...item, id: `item-${++seq}`, job: id };
        items.push(row);
        return row.id;
      },
    ),
    updateItem: vi.fn(async (i) => {
      owned(i.workspaceId, i.jobId, i.workerId);
      const row = items.find((x) => x.id === i.itemId && x.job === i.jobId);
      if (!row) throw new JobNotFoundError();
      Object.assign(row, {
        final: i.status,
        uploaded: i.uploaded,
        skipped: i.skipped,
        failed: i.failed,
      });
    }),
    imageStates: vi.fn(
      async (
        storeId: string,
        productId: string,
        fileIds: string[],
      ): Promise<ImageState[]> =>
        images
          .filter(
            (r) =>
              r.storeId === storeId &&
              r.shopifyProductId === productId &&
              fileIds.includes(r.driveFileId),
          )
          .map((r) => ({
            driveFileId: r.driveFileId,
            uploadStatus: r.uploadStatus,
            checksum: r.checksum,
            driveModifiedAt: r.driveModifiedAt,
            shopifyMediaId: r.shopifyMediaId,
            retryable: r.retryable,
            attemptCount: r.attemptCount,
            lastAttemptAt: r.lastAttemptAt
              ? new Date(r.lastAttemptAt).toISOString()
              : null,
          })),
    ),
  };

  const find = (scope: { storeId: string; imageId: string }) => {
    const r = images.find(
      (x) => x.id === scope.imageId && x.storeId === scope.storeId,
    );
    if (!r) throw new Error("image not found");
    return r;
  };
  const images_: SyncImageRepository = {
    claim: vi.fn(async (c: ClaimInput) => {
      let r = images.find(
        (x) =>
          x.storeId === c.storeId &&
          x.shopifyProductId === c.shopifyProductId &&
          x.driveFileId === c.driveFileId,
      );
      const mod = c.driveModifiedAt?.toISOString() ?? null;
      let action: ClaimAction;
      if (!r) {
        r = {
          id: `img-${++seq}`,
          storeId: c.storeId,
          shopifyProductId: c.shopifyProductId,
          driveFileId: c.driveFileId,
          shopifyMediaId: null,
          uploadStatus: "pending",
          errorCode: null,
          retryable: null,
          attemptCount: 0,
          checksum: c.checksum,
          driveModifiedAt: mod,
          filename: c.filename,
          lastAttemptAt: null,
        };
        images.push(r);
        action = "upload";
      } else {
        const changed =
          c.checksum && r.checksum
            ? c.checksum !== r.checksum
            : mod && r.driveModifiedAt
              ? mod !== r.driveModifiedAt
              : false;
        if (r.uploadStatus === "uploaded" && !changed) action = "skip";
        else if (r.uploadStatus === "processing") action = "resume";
        else if (
          r.uploadStatus === "pending" &&
          r.lastAttemptAt &&
          r.lastAttemptAt > clock.now - 900_000
        )
          action = "busy";
        else if (
          r.uploadStatus === "failed" &&
          !changed &&
          (!r.retryable || r.attemptCount >= 5)
        )
          action = "blocked";
        else if (r.uploadStatus === "failed" && !changed && r.shopifyMediaId)
          action = "resume";
        else {
          action = "upload";
          Object.assign(r, {
            uploadStatus: "pending",
            checksum: c.checksum,
            driveModifiedAt: mod,
            shopifyMediaId: changed ? null : r.shopifyMediaId,
          });
        }
      }
      return { action, image: { ...r } };
    }),
    recordAttempt: vi.fn(async (s) => {
      const r = find(s);
      r.attemptCount += 1;
      r.lastAttemptAt = clock.now;
      return { ...r };
    }),
    markProcessing: vi.fn(async (s, mediaId: string) =>
      Object.assign(find(s), {
        uploadStatus: "processing",
        shopifyMediaId: mediaId,
      }),
    ),
    markUploaded: vi.fn(async (s, mediaId: string) =>
      Object.assign(find(s), {
        uploadStatus: "uploaded",
        shopifyMediaId: mediaId,
        errorCode: null,
        retryable: null,
      }),
    ),
    resetMissing: vi.fn(async (i) => {
      const r = images.find(
        (x) =>
          x.storeId === i.storeId &&
          x.shopifyProductId === i.shopifyProductId &&
          x.driveFileId === i.driveFileId,
      );
      if (!r) throw new Error("image not found");
      Object.assign(r, {
        uploadStatus: "pending",
        shopifyMediaId: null,
        attemptCount: 0,
        lastAttemptAt: null,
        errorCode: null,
        retryable: null,
      });
      return { ...r };
    }),
    markFailed: vi.fn(async (s, e) =>
      Object.assign(find(s), {
        uploadStatus: "failed",
        errorCode: e.code,
        retryable: e.retryable,
      }),
    ),
  };

  return {
    jobs,
    items,
    images,
    heartbeats,
    addJob,
    repo: jobs_,
    imagesRepo: images_,
  };
}

// ---------------------------------------------------------------------------
// Drive scan (output of scanCategoryRoots — Prompt 12 has its own tests)
// ---------------------------------------------------------------------------

export const img = (
  fileId: string,
  folderId: string,
  filename = `${fileId}.jpg`,
  md5 = `md5-${fileId}`,
): ScanImage => ({
  fileId,
  folderId,
  filename,
  mimeType: "image/jpeg",
  size: 2048,
  modifiedTime: "2026-09-01T00:00:00.000Z",
  md5Checksum: md5,
});

export const product = (n: number, title: string) => ({
  id: `gid://shopify/Product/${n}`,
  title,
  handle: title.toLowerCase(),
  status: "ACTIVE",
});

export function item(o: {
  root?: string;
  code: string;
  folder: string;
  name: string;
  outcome:
    "no_product_found" | "single_match" | "multiple_matches" | "search_failed";
  products?: ReturnType<typeof product>[];
  images?: ScanImage[];
  error?: { code: string; message: string; retryable: boolean };
}): ScanItem {
  return {
    category_root: {
      id: o.root ?? SOFA,
      name: o.root === SOFA_BED ? "Sofa bed image" : "Sofa image",
    },
    code_folder: { id: `code-${o.code}`, name: o.code },
    product_folder: { id: o.folder, name: o.name },
    match:
      o.outcome === "search_failed"
        ? {
            outcome: "search_failed",
            products: [],
            error: o.error ?? {
              code: "SHOPIFY_UNAVAILABLE",
              message: "x",
              retryable: true,
            },
          }
        : { outcome: o.outcome, products: o.products ?? [], truncated: false },
    images: o.images ?? [],
    images_truncated: false,
    nested_folders: [],
  };
}

/** Sofa image: SOF-001/Milano (1 match, 2 images), SOF-002/Roma (2 matches), SOF-003/Minor (0 matches). */
export function defaultTree(): Record<string, ScanItem[]> {
  return {
    [SOFA]: [
      item({
        code: "SOF-001",
        folder: "prodMilanoxxxxx",
        name: "Milano",
        outcome: "single_match",
        products: [product(1, "Milano")],
        images: [
          img("milano1jpgxxxxx", "prodMilanoxxxxx", "1.jpg"),
          img("milano2jpgxxxxx", "prodMilanoxxxxx", "2.jpg"),
        ],
      }),
      item({
        code: "SOF-002",
        folder: "prodRomaxxxxxxx",
        name: "Roma",
        outcome: "multiple_matches",
        products: [product(2, "Roma"), product(3, "Roma")],
        images: [img("roma1jpgxxxxxxx", "prodRomaxxxxxxx", "1.jpg")],
      }),
      item({
        code: "SOF-003",
        folder: "prodMinorxxxxxx",
        name: "Minor",
        outcome: "no_product_found",
        images: [img("minor1jpgxxxxxx", "prodMinorxxxxxx", "1.jpg")],
      }),
    ],
    [SOFA_BED]: [
      item({
        root: SOFA_BED,
        code: "SOFB-001",
        folder: "prodDurresxxxxx",
        name: "Durres",
        outcome: "single_match",
        products: [product(4, "Durres")],
        images: [img("durres1jpgxxxxx", "prodDurresxxxxx", "1.jpg")],
      }),
    ],
  };
}

export function storeContext(
  over: Partial<StoreDriveContext> = {},
): StoreDriveContext {
  return {
    storeId: W_STORE,
    workspaceId: W_WS,
    connectionStatus: "connected",
    googleAccountId: "acct-1",
    rootFolderId: SOFA,
    rootFolderName: "Sofa image",
    categoryRoots: [
      { id: SOFA, name: "Sofa image" },
      { id: SOFA_BED, name: "Sofa bed image" },
    ],
    allowedImageTypes: ["jpg", "jpeg", "png", "webp"],
    ignoredFolders: ["OG"],
    ...over,
  };
}

export const SECRET_MARKERS = [
  "shpat_SECRET",
  "ya29.ACCESS_SECRET",
  "1//REFRESH_SECRET",
  "pis_live_",
  "service_role",
  "Bearer ",
];

/** Wires a full set of fake worker deps. */
export function workerEnv(
  opts: {
    tree?: Record<string, ScanItem[]>;
    ctx?: StoreDriveContext | null;
  } = {},
) {
  const clock = { now: T0 };
  const db = fakeWorkerDb(clock);
  const tree = opts.tree ?? defaultTree();
  const ctx = opts.ctx === undefined ? storeContext() : opts.ctx;
  const bytesByFile = new Map<string, Uint8Array>();

  const scan = vi.fn(
    async (input: {
      workspaceId: string;
      storeId: string;
      categoryRootIds?: string[];
    }): Promise<ScanResult> => {
      const roots = input.categoryRootIds ?? Object.keys(tree);
      const items = roots.flatMap((r) => tree[r] ?? []);
      return {
        store_id: input.storeId,
        category_roots: roots.map((id) => ({
          id,
          name: id,
          code_folders: 0,
          product_folders: items.length,
          images: 0,
          accessible: true,
        })),
        items,
        warnings: [],
        stats: {
          code_folders: 0,
          product_folders: items.length,
          images: 0,
          ignored_folders: 0,
          unsupported_files: 0,
          drive_list_requests: 0,
          shopify_searches: 0,
        },
      };
    },
  );

  const download = vi.fn(
    async (c: { workspaceId: string; storeId: string; fileId: string }) => {
      const buffer = Buffer.from(`JPEG-BYTES-${c.fileId}`);
      bytesByFile.set(c.fileId, buffer);
      return {
        fileId: c.fileId,
        name: `${c.fileId}.jpg`,
        mimeType: "image/jpeg",
        size: buffer.length,
        buffer,
      } as never;
    },
  );

  let media = 1000;
  const attachedMediaByProduct = new Map<string, Set<string>>();
  const attachedFor = (productId: string) => {
    let set = attachedMediaByProduct.get(productId);
    if (!set) {
      set = new Set<string>();
      attachedMediaByProduct.set(productId, set);
    }
    return set;
  };
  const getAttachedProductMediaIds = vi.fn(
    async ({ productId }: { workspaceId: string; storeId: string; productId: string }) =>
      new Set(attachedFor(productId)),
  );

  /** Mimics uploadProductImage: sync_image_claim → (Shopify) → mark uploaded. */
  const upload = vi.fn(
    async (
      input: UploadProductImageInput,
      deps: { images: SyncImageRepository },
    ): Promise<UploadProductImageResult> => {
      const claim = await deps.images.claim({
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        syncItemId: input.syncItemId ?? null,
        shopifyProductId: input.shopifyProductId,
        driveFileId: input.driveFileId,
        driveFolderId: input.driveFolderId ?? null,
        filename: input.filename,
        checksum: input.checksum ?? null,
        driveModifiedAt: input.driveModifiedAt ?? null,
        mimeType: input.mimeType,
        fileSize: input.bytes.length,
      });
      const scope = {
        workspaceId: input.workspaceId,
        storeId: input.storeId,
        imageId: claim.image.id,
      };
      if (claim.action === "skip")
        return {
          status: "skipped",
          productId: input.shopifyProductId,
          mediaId: claim.image.shopifyMediaId,
          reason: "already_uploaded",
        };
      if (claim.action === "busy")
        return {
          status: "skipped",
          productId: input.shopifyProductId,
          mediaId: null,
          reason: "in_progress",
        };
      if (claim.action === "blocked")
        return {
          status: "skipped",
          productId: input.shopifyProductId,
          mediaId: null,
          reason: "permanent_failure",
        };
      await deps.images.recordAttempt(scope);
      const mediaId =
        claim.image.shopifyMediaId ?? `gid://shopify/MediaImage/${++media}`;
      await deps.images.markUploaded(scope, mediaId);
      attachedFor(input.shopifyProductId).add(mediaId);
      return { status: "uploaded", productId: input.shopifyProductId, mediaId };
    },
  );

  const deps: WorkerDeps = {
    jobs: db.repo,
    images: db.imagesRepo,
    google: {
      config: {} as never,
      repo: {} as never,
      downloads: {
        getStoreDriveContext: vi.fn(async (storeId: string) =>
          ctx && storeId === ctx.storeId ? ctx : null,
        ),
      },
    },
    shopify: { config: {} as never, repo: {} as never },
    scan: scan as unknown as WorkerDeps["scan"],
    download: download as unknown as WorkerDeps["download"],
    upload: upload as unknown as WorkerDeps["upload"],
    getAttachedProductMediaIds:
      getAttachedProductMediaIds as unknown as WorkerDeps["getAttachedProductMediaIds"],
    sleep: vi.fn(async () => undefined),
    now: () => clock.now,
    newWorkerId: () => `worker-test-${Math.random().toString(36).slice(2, 10)}`,
  };
  return {
    clock,
    db,
    deps,
    scan,
    download,
    upload,
    getAttachedProductMediaIds,
    attachedMediaByProduct,
    bytesByFile,
    tree,
  };
}
