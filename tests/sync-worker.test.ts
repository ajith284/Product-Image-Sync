import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DriveDownloadError } from "@/lib/google/download";
import type { UploadProductImageResult } from "@/lib/shopify/media";
import { predictImageAction, runSyncJob } from "@/lib/sync/worker";
import {
  img,
  item,
  SECRET_MARKERS,
  SOFA,
  SOFA_BED,
  storeContext,
  W_JOB,
  W_OTHER_STORE,
  W_OTHER_WS,
  W_STORE,
  W_WS,
  workerEnv,
} from "./helpers/fake-worker";

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

const run = (
  env: ReturnType<typeof workerEnv>,
  o: { workspaceId?: string; workerId?: string } = {},
) =>
  runSyncJob(
    { jobId: W_JOB, workspaceId: o.workspaceId ?? W_WS, workerId: o.workerId },
    env.deps,
  );

const job = (env: ReturnType<typeof workerEnv>) => env.db.jobs.get(W_JOB)!;
const uploadedFiles = (env: ReturnType<typeof workerEnv>) =>
  env.upload.mock.calls.map((c) => c[0].driveFileId);

describe("sync worker — claim / ownership", () => {
  it("1. claims a queued job (queued → running → completed) and only one worker holds it", async () => {
    const env = workerEnv();
    env.db.addJob();
    const res = await run(env);
    expect(res.status).toBe("completed");
    expect(env.db.repo.claim).toHaveBeenCalledTimes(1);
    expect(job(env).status).toBe("completed");
    expect(job(env).worker_id).toBeNull();
  });

  it("2. a second worker cannot claim a running job (lease alive) and does nothing", async () => {
    const env = workerEnv();
    env.db.addJob({
      status: "running",
      worker_id: "worker-other-1",
      heartbeat_at: env.clock.now,
    });
    const res = await run(env);
    expect(res).toEqual({ status: "not_claimed", reason: "already_running" });
    expect(env.scan).not.toHaveBeenCalled();
    expect(env.download).not.toHaveBeenCalled();
    expect(env.upload).not.toHaveBeenCalled();
    const done = workerEnv();
    done.db.addJob({ status: "completed" });
    expect(await run(done)).toEqual({
      status: "not_claimed",
      reason: "finished",
    });
  });

  it("3. wrong workspace: the job is not found, nothing runs", async () => {
    const env = workerEnv();
    env.db.addJob();
    expect(await run(env, { workspaceId: W_OTHER_WS })).toEqual({
      status: "not_claimed",
      reason: "job_not_found",
    });
    expect(job(env).status).toBe("queued");
    expect(env.scan).not.toHaveBeenCalled();
  });

  it("4. wrong store: a job whose store isn't in the workspace fails safely without scanning", async () => {
    const env = workerEnv();
    env.db.addJob({ store_id: W_OTHER_STORE });
    const res = await run(env);
    expect(res.status).toBe("failed");
    expect(job(env).error_code).toBe("STORE_NOT_FOUND");
    expect(env.scan).not.toHaveBeenCalled();
    // store exists but belongs to another workspace → same answer
    const env2 = workerEnv({ ctx: storeContext({ workspaceId: W_OTHER_WS }) });
    env2.db.addJob();
    expect((await run(env2)).status).toBe("failed");
    expect(job(env2).error_code).toBe("STORE_NOT_FOUND");
  });
});

describe("sync worker — Drive hierarchy and matching", () => {
  it("5–6. scans every connected category root separately, with the job's own store", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    expect(env.scan).toHaveBeenCalledTimes(2);
    expect(env.scan.mock.calls.map((c) => c[0])).toEqual([
      { workspaceId: W_WS, storeId: W_STORE, categoryRootIds: [SOFA] },
      { workspaceId: W_WS, storeId: W_STORE, categoryRootIds: [SOFA_BED] },
    ]);
    expect(job(env).progress.total).toBe(4);
  });

  it("7–8. records each PRODUCT folder with its category root and code folder (code folder is never a product)", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    expect(
      env.db.items.map((i) => [
        i.category_root_id,
        i.code_folder_name,
        i.drive_folder_name,
      ]),
    ).toEqual([
      [SOFA, "SOF-001", "Milano"],
      [SOFA, "SOF-002", "Roma"],
      [SOFA, "SOF-003", "Minor"],
      [SOFA_BED, "SOFB-001", "Durres"],
    ]);
    expect(env.db.items.some((i) => /^SOF/.test(i.drive_folder_name))).toBe(
      false,
    );
  });

  it("9. only the product folder's match decides the Shopify product", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    const milano = env.db.items.find((i) => i.drive_folder_name === "Milano")!;
    expect(milano.shopify_product_id).toBe("gid://shopify/Product/1");
    expect(
      env.upload.mock.calls
        .filter((c) => c[0].driveFolderId === "prodMilanoxxxxx")
        .every((c) => c[0].shopifyProductId === "gid://shopify/Product/1"),
    ).toBe(true);
  });

  it("10. zero matches → review, no download, no upload", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    expect(
      env.db.items.find((i) => i.drive_folder_name === "Minor")!.status,
    ).toBe("no_product_found");
    expect(
      env.download.mock.calls.some((c) => c[0].fileId === "minor1jpgxxxxxx"),
    ).toBe(false);
    expect(uploadedFiles(env)).not.toContain("minor1jpgxxxxxx");
  });

  it("11. single match → every image downloaded and uploaded to that product", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    expect(uploadedFiles(env)).toEqual([
      "milano1jpgxxxxx",
      "milano2jpgxxxxx",
      "durres1jpgxxxxx",
    ]);
    expect(
      env.db.items.find((i) => i.drive_folder_name === "Milano")!.final,
    ).toBe("synced");
  });

  it("12. multiple matches → review with all candidates, never picks one", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    const roma = env.db.items.find((i) => i.drive_folder_name === "Roma")!;
    expect(roma.status).toBe("multiple_matches");
    expect(roma.shopify_product_id).toBeNull();
    expect(roma.match_candidates.map((c) => c.id)).toEqual([
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
    ]);
    expect(uploadedFiles(env)).not.toContain("roma1jpgxxxxxxx");
    expect(job(env).progress.review).toBe(2);
    expect((job(env).result!.review_items as unknown[]).length).toBe(2);
  });

  it("a code folder with images but no product folder (like the current test Drive) yields no product and no download", async () => {
    const env = workerEnv({
      tree: { [SOFA]: [] },
      ctx: storeContext({ categoryRoots: [{ id: SOFA, name: "Sofa image" }] }),
    });
    env.db.addJob();
    const res = await run(env);
    expect(res.status).toBe("completed");
    expect(env.download).not.toHaveBeenCalled();
    expect(env.upload).not.toHaveBeenCalled();
    expect(job(env).progress).toMatchObject({
      total: 0,
      processed: 0,
      uploaded: 0,
    });
  });
});

describe("sync worker — images and duplicates", () => {
  it("13. already uploaded + unchanged → skipped WITHOUT downloading", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    env.download.mockClear();
    env.upload.mockClear();
    env.db.addJob(); // a new job over the same Drive
    await run(env);
    expect(env.download).not.toHaveBeenCalled();
    expect(env.upload).not.toHaveBeenCalled();
    expect(job(env).progress).toMatchObject({ uploaded: 0, skipped: 3 });
  });


  it("13b. image deleted from Shopify product → only that Drive image is uploaded again", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);

    const missing = env.db.images.find(
      (r) =>
        r.shopifyProductId === "gid://shopify/Product/1" &&
        r.driveFileId === "milano1jpgxxxxx",
    )!;
    expect(missing.shopifyMediaId).toBeTruthy();
    env.attachedMediaByProduct
      .get("gid://shopify/Product/1")!
      .delete(missing.shopifyMediaId!);

    env.download.mockClear();
    env.upload.mockClear();
    env.db.addJob();
    await run(env);

    expect(uploadedFiles(env)).toEqual(["milano1jpgxxxxx"]);
    expect(env.download.mock.calls.map((call) => call[0].fileId)).toEqual([
      "milano1jpgxxxxx",
    ]);
    expect(job(env).progress).toMatchObject({
      uploaded: 1,
      skipped: 2,
      failed: 0,
    });
    expect(env.db.images.find((r) => r.driveFileId === "milano1jpgxxxxx"))
      .toMatchObject({ uploadStatus: "uploaded" });
  });

  it("14. changed checksum → uploaded again; same filename with a different Drive file → separate upload", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    const milano = env.tree[SOFA]![0]!;
    milano.images = [
      img("milano1jpgxxxxx", "prodMilanoxxxxx", "1.jpg", "md5-CHANGED"),
      img("milano2jpgxxxxx", "prodMilanoxxxxx", "2.jpg"),
      img("milanoNEWfilexx", "prodMilanoxxxxx", "1.jpg"),
    ];
    env.upload.mockClear();
    env.db.addJob();
    await run(env);
    expect(uploadedFiles(env)).toEqual(["milano1jpgxxxxx", "milanoNEWfilexx"]);
    // changed modified time without checksum also counts as changed
    expect(
      predictImageAction(
        {
          driveFileId: "f",
          uploadStatus: "uploaded",
          checksum: null,
          driveModifiedAt: "2026-01-01T00:00:00Z",
          shopifyMediaId: "m",
          retryable: null,
          attemptCount: 1,
          lastAttemptAt: null,
        },
        { md5Checksum: null, modifiedTime: "2026-02-01T00:00:00Z" },
        0,
      ),
    ).toBe("upload");
  });

  it("15–16. download → upload pipeline passes bytes server-side only, with the job's workspace/store", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    expect(env.download).toHaveBeenCalledWith(
      { workspaceId: W_WS, storeId: W_STORE, fileId: "milano1jpgxxxxx" },
      env.deps.google,
    );
    const call = env.upload.mock.calls[0]![0];
    expect(call).toMatchObject({
      workspaceId: W_WS,
      storeId: W_STORE,
      shopifyProductId: "gid://shopify/Product/1",
      dryRun: false,
      checksum: "md5-milano1jpgxxxxx",
    });
    expect(Buffer.from(call.bytes).toString()).toBe(
      "JPEG-BYTES-milano1jpgxxxxx",
    );
    expect(job(env).progress.uploaded).toBe(3);
  });

  it("a processing image is resumed without downloading again", async () => {
    const env = workerEnv();
    env.db.addJob();
    env.db.images.push({
      id: "img-pre",
      storeId: W_STORE,
      shopifyProductId: "gid://shopify/Product/1",
      driveFileId: "milano1jpgxxxxx",
      shopifyMediaId: "gid://shopify/MediaImage/77",
      uploadStatus: "processing",
      errorCode: null,
      retryable: null,
      attemptCount: 1,
      checksum: "md5-milano1jpgxxxxx",
      driveModifiedAt: "2026-09-01T00:00:00.000Z",
      filename: "1.jpg",
      lastAttemptAt: env.clock.now,
    });
    await run(env);
    expect(env.download.mock.calls.map((c) => c[0].fileId)).not.toContain(
      "milano1jpgxxxxx",
    );
    expect(env.upload.mock.calls[0]![0].bytes.length).toBe(0);
    expect(env.db.images.find((r) => r.id === "img-pre")!.uploadStatus).toBe(
      "uploaded",
    );
  });

  it("17. retryable failures are retried (bounded, honouring Retry-After) and then succeed", async () => {
    const env = workerEnv();
    env.db.addJob();
    env.download.mockRejectedValueOnce(
      new DriveDownloadError("GOOGLE_DRIVE_THROTTLED", {
        retryAfterSeconds: 7,
      }),
    );
    const real = env.upload.getMockImplementation()!;
    env.upload.mockImplementationOnce(
      async () =>
        ({
          status: "failed",
          productId: "gid://shopify/Product/1",
          mediaId: null,
          error: {
            code: "SHOPIFY_THROTTLED",
            message: "Slow down",
            retryable: true,
            retryAfterSeconds: 3,
          },
        }) as UploadProductImageResult,
    );
    env.upload.mockImplementation(real);
    const res = await run(env);
    expect(res.status).toBe("completed");
    expect(env.deps.sleep).toHaveBeenCalledWith(7000);
    expect(env.deps.sleep).toHaveBeenCalledWith(3000);
    expect(job(env).progress.uploaded).toBe(3);
  });

  it("18. permanent failures are not retried; the image is recorded as failed and later blocked", async () => {
    const env = workerEnv();
    env.db.addJob();
    env.download.mockImplementation(async (c: { fileId: string }) => {
      if (c.fileId === "milano2jpgxxxxx")
        throw new DriveDownloadError("UNSUPPORTED_MIME_TYPE");
      const buffer = Buffer.from("x");
      return { fileId: c.fileId, mimeType: "image/jpeg", buffer } as never;
    });
    const res = await run(env);
    expect(res.status).toBe("completed_with_errors");
    expect(
      env.download.mock.calls.filter((c) => c[0].fileId === "milano2jpgxxxxx"),
    ).toHaveLength(1);
    const row = env.db.images.find((r) => r.driveFileId === "milano2jpgxxxxx")!;
    expect(row).toMatchObject({
      uploadStatus: "failed",
      errorCode: "UNSUPPORTED_MIME_TYPE",
      retryable: false,
    });
    env.download.mockClear();
    env.db.addJob();
    await run(env);
    expect(env.download).not.toHaveBeenCalled(); // blocked, not retried blindly
    expect(job(env).result!.blocked).toBe(1);
  });

  it("22. partial failure: other images and products still complete", async () => {
    const env = workerEnv();
    env.db.addJob();
    const real = env.upload.getMockImplementation()!;
    env.upload.mockImplementation(async (input, d) =>
      input.driveFileId === "milano2jpgxxxxx"
        ? ({
            status: "failed",
            productId: input.shopifyProductId,
            mediaId: null,
            error: { code: "INVALID_IMAGE", message: "bad", retryable: false },
          } as UploadProductImageResult)
        : real(input, d),
    );
    const res = await run(env);
    expect(res.status).toBe("completed_with_errors");
    expect(job(env).progress).toMatchObject({ uploaded: 2, failed: 1 });
    expect(
      env.db.items.find((i) => i.drive_folder_name === "Milano")!.final,
    ).toBe("upload_failed");
    expect(
      env.db.items.find((i) => i.drive_folder_name === "Durres")!.final,
    ).toBe("synced");
  });
});

describe("sync worker — cancellation, dry run, progress", () => {
  it("19. cancellation stops new work, keeps completed uploads and finishes as cancelled", async () => {
    const env = workerEnv();
    env.db.addJob();
    const real = env.upload.getMockImplementation()!;
    env.upload.mockImplementation(async (input, d) => {
      const r = await real(input, d);
      job(env).cancel_requested = true; // requested while the first image uploads
      return r;
    });
    const res = await run(env);
    expect(res.status).toBe("cancelled");
    expect(env.upload).toHaveBeenCalledTimes(1);
    expect(
      env.db.images.filter((r) => r.uploadStatus === "uploaded"),
    ).toHaveLength(1);
    expect(job(env).progress.uploaded).toBe(1);
    expect(env.scan).toHaveBeenCalledTimes(1); // the second category root is never started
  });

  it("cancellation requested before start: no scan at all", async () => {
    const env = workerEnv();
    env.db.addJob({ cancel_requested: true });
    expect((await run(env)).status).toBe("cancelled");
    expect(env.scan).not.toHaveBeenCalled();
  });

  it("20. dry run: scan + match + metadata only — no download, no upload, no sync_images writes", async () => {
    const env = workerEnv();
    env.db.addJob({ dry_run: true });
    const res = await run(env);
    expect(res.status).toBe("completed");
    expect(env.download).not.toHaveBeenCalled();
    expect(env.upload).not.toHaveBeenCalled();
    expect(env.db.images).toHaveLength(0);
    for (const fn of Object.values(env.db.imagesRepo))
      expect(fn).not.toHaveBeenCalled();
    expect(job(env).result).toMatchObject({
      dry_run: true,
      plan: { would_upload: 3, skipped: 0, review: 2, failed: 0 },
    });
  });

  it("dry run reports what would be skipped for already-uploaded images", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    env.db.addJob({ dry_run: true });
    await run(env);
    expect(job(env).result).toMatchObject({
      plan: { would_upload: 0, skipped: 3 },
    });
  });

  it("21. progress (total/processed/uploaded/skipped/review/failed) is reported throughout the job", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    expect(env.db.heartbeats.length).toBeGreaterThan(5);
    const processed = env.db.heartbeats.map((h) => h.processed ?? 0);
    expect(processed).toEqual([...processed].sort((a, b) => a - b));
    expect(job(env).progress).toMatchObject({
      total: 4,
      processed: 4,
      uploaded: 3,
      skipped: 0,
      review: 2,
      failed: 0,
      synced: 2,
    });
  });
});

describe("sync worker — failures and recovery", () => {
  it("23. Shopify needs reconnect: stops Shopify processing, keeps completed work, job failed", async () => {
    const env = workerEnv();
    env.db.addJob();
    const real = env.upload.getMockImplementation()!;
    env.upload.mockImplementation(async (input, d) =>
      input.driveFileId === "milano2jpgxxxxx"
        ? ({
            status: "failed",
            productId: input.shopifyProductId,
            mediaId: null,
            error: {
              code: "SHOPIFY_NEEDS_RECONNECT",
              message: "Reconnect Shopify.",
              retryable: false,
            },
          } as UploadProductImageResult)
        : real(input, d),
    );
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "SHOPIFY_NEEDS_RECONNECT",
    });
    expect(uploadedFiles(env)).toEqual(["milano1jpgxxxxx", "milano2jpgxxxxx"]); // Durres never attempted
    expect(
      env.db.images.find((r) => r.driveFileId === "milano1jpgxxxxx")!
        .uploadStatus,
    ).toBe("uploaded");
    // a revoked token seen during product search also stops the job
    const env2 = workerEnv({
      tree: {
        [SOFA]: [
          item({
            code: "S",
            folder: "prodXxxxxxxxxxx",
            name: "X",
            outcome: "search_failed",
            error: {
              code: "SHOPIFY_UNAUTHORIZED",
              message: "x",
              retryable: false,
            },
          }),
        ],
      },
      ctx: storeContext({ categoryRoots: [{ id: SOFA, name: "Sofa image" }] }),
    });
    env2.db.addJob();
    expect(await run(env2)).toMatchObject({
      status: "failed",
      errorCode: "SHOPIFY_NEEDS_RECONNECT",
    });
  });

  it("24. Google unavailable after bounded retries: stops safely, completed work kept", async () => {
    const env = workerEnv();
    env.db.addJob();
    env.download.mockImplementation(async (c: { fileId: string }) => {
      if (c.fileId === "milano1jpgxxxxx")
        return {
          fileId: c.fileId,
          mimeType: "image/jpeg",
          buffer: Buffer.from("x"),
        } as never;
      throw new DriveDownloadError("GOOGLE_DRIVE_UNAVAILABLE");
    });
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "GOOGLE_DRIVE_UNAVAILABLE",
    });
    expect(
      env.download.mock.calls.filter((c) => c[0].fileId === "milano2jpgxxxxx"),
    ).toHaveLength(3); // bounded
    expect(uploadedFiles(env)).toEqual(["milano1jpgxxxxx"]);
    // Google disconnected before the run
    const env2 = workerEnv({
      ctx: storeContext({ connectionStatus: "needs_reconnect" }),
    });
    env2.db.addJob();
    expect(await run(env2)).toMatchObject({
      status: "failed",
      errorCode: "GOOGLE_DRIVE_NOT_CONNECTED",
    });
    expect(env2.scan).not.toHaveBeenCalled();
  });

  it("25. crash recovery: a job whose worker stopped heart-beating is re-claimed and resumed", async () => {
    const env = workerEnv();
    env.db.addJob({
      status: "running",
      worker_id: "worker-crashed-1",
      heartbeat_at: env.clock.now - 901_000,
    });
    const res = await run(env);
    expect(res.status).toBe("completed");
    expect(
      await vi.mocked(env.db.repo.claim).mock.results[0]!.value,
    ).toMatchObject({ claimed: true, reason: "reclaimed" });
  });

  it("the old worker stops when it has lost its lease (no double processing)", async () => {
    const env = workerEnv();
    env.db.addJob();
    const real = env.upload.getMockImplementation()!;
    env.upload.mockImplementationOnce(async (input, d) => {
      const r = await real(input, d);
      job(env).worker_id = "worker-new-owner"; // another worker re-claimed it
      return r;
    });
    const res = await run(env);
    expect(res.status).toBe("lost_lease");
    expect(env.upload).toHaveBeenCalledTimes(1);
    expect(job(env).status).toBe("running"); // left to the new owner
  });

  it("26. idempotent restart: re-running over the same Drive never duplicates items or uploads", async () => {
    const env = workerEnv();
    env.db.addJob();
    await run(env);
    // same job re-run after a crash mid-way: items upserted per product folder
    env.db.addJob({
      status: "running",
      worker_id: "w-crashed-xx",
      heartbeat_at: 0,
    });
    await run(env);
    expect(env.db.items).toHaveLength(4);
    expect(env.upload).toHaveBeenCalledTimes(3);
    expect(env.db.images).toHaveLength(3);
  });

  it("27. no secrets or image bytes in results, progress, items or logs", async () => {
    const env = workerEnv();
    env.db.addJob();
    env.download.mockImplementation(async (c: { fileId: string }) => {
      if (c.fileId === "durres1jpgxxxxx")
        throw new Error("token ya29.ACCESS_SECRET_1 leaked?");
      return {
        fileId: c.fileId,
        mimeType: "image/jpeg",
        buffer: Buffer.from("JPEG-BYTES-SECRET-IMAGE"),
      } as never;
    });
    await run(env);
    const blob = JSON.stringify({
      job: job(env),
      items: env.db.items,
      images: env.db.images,
      logs,
    });
    for (const marker of [...SECRET_MARKERS, "JPEG-BYTES"])
      expect(blob).not.toContain(marker);
    expect(job(env).error_code).toBe("INTERNAL_ERROR");
  });
});

describe("predictImageAction mirrors sync_image_claim", () => {
  const base = {
    driveFileId: "f",
    checksum: "a",
    driveModifiedAt: null,
    shopifyMediaId: null,
    retryable: null,
    attemptCount: 1,
    lastAttemptAt: null,
  };
  const meta = { md5Checksum: "a", modifiedTime: null };
  it.each([
    [undefined, "upload"],
    [{ ...base, uploadStatus: "uploaded" }, "skip"],
    [{ ...base, uploadStatus: "processing" }, "resume"],
    [{ ...base, uploadStatus: "failed", retryable: true }, "upload"],
    [{ ...base, uploadStatus: "failed", retryable: false }, "blocked"],
    [
      { ...base, uploadStatus: "failed", retryable: true, attemptCount: 5 },
      "blocked",
    ],
    [
      { ...base, uploadStatus: "failed", retryable: true, shopifyMediaId: "m" },
      "resume",
    ],
    [
      {
        ...base,
        uploadStatus: "pending",
        lastAttemptAt: new Date(1000).toISOString(),
      },
      "busy",
    ],
  ] as const)("%o → %s", (state, expected) => {
    expect(predictImageAction(state as never, meta, 2000)).toBe(expected);
  });
});
