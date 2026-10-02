import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DriveDownloadError } from "@/lib/google/download";
import type { UploadProductImageResult } from "@/lib/shopify/media";
import { predictImageAction, runSyncJob } from "@/lib/sync/worker";
import {
  img,
  item,
  product,
  SECRET_MARKERS,
  SOFA,
  storeContext,
  W_JOB,
  W_STORE,
  W_WS,
  workerEnv,
} from "./helpers/fake-worker";

/**
 * Prompt 14E — worker failure and recovery modes not covered by tests/sync-worker.test.ts:
 * database outages at every write point, background-launch failures, logging failures,
 * concurrent runs, Drive / Shopify resources disappearing mid-run, retry bounds.
 * Fakes only (tests/helpers/fake-worker.ts mirrors the SQL lease / ledger rules).
 */

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

const DB_SECRET = "postgres://service_role:sb_secret_DBLEAK@db.internal:5432";
const run = (env: ReturnType<typeof workerEnv>, workerId?: string) =>
  runSyncJob({ jobId: W_JOB, workspaceId: W_WS, workerId }, env.deps);
const job = (env: ReturnType<typeof workerEnv>) => env.db.jobs.get(W_JOB)!;
const uploaded = (env: ReturnType<typeof workerEnv>) =>
  env.db.images
    .filter((r) => r.uploadStatus === "uploaded")
    .map((r) => r.driveFileId);
const noLeak = (value: unknown) => {
  const text = JSON.stringify(value) + "\n" + logs.join("\n");
  return [...SECRET_MARKERS, "sb_secret_", "JPEG-BYTES"].filter((m) =>
    text.includes(m),
  );
};

/** A single-root tree: Milano (1 match, 3 images) + Durres (1 match, 1 image). */
function oneRoot() {
  return {
    tree: {
      [SOFA]: [
        item({
          code: "SOF-001",
          folder: "prodMilanoxxxxx",
          name: "Milano",
          outcome: "single_match" as const,
          products: [product(1, "Milano")],
          images: [
            img("milano1jpgxxxxx", "prodMilanoxxxxx", "1.jpg"),
            img("milano2jpgxxxxx", "prodMilanoxxxxx", "2.jpg"),
            img("milano3jpgxxxxx", "prodMilanoxxxxx", "3.jpg"),
          ],
        }),
        item({
          code: "SOF-002",
          folder: "prodDurresxxxxx",
          name: "Durres",
          outcome: "single_match" as const,
          products: [product(4, "Durres")],
          images: [img("durres1jpgxxxxx", "prodDurresxxxxx", "1.jpg")],
        }),
      ],
    },
    ctx: storeContext({ categoryRoots: [{ id: SOFA, name: "Sofa image" }] }),
  };
}

// ---------------------------------------------------------------------------
describe("database outages", () => {
  it("progress write (heartbeat) fails mid-run → job finishes failed/INTERNAL_ERROR, completed uploads kept", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.db.repo.heartbeat;
    env.deps.jobs = {
      ...env.db.repo,
      heartbeat: vi.fn(async (...a: Parameters<typeof real>) => {
        if ((a[3]?.uploaded ?? 0) >= 2)
          throw new Error(`could not write progress: ${DB_SECRET}`);
        return real(...a);
      }),
    };
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    });
    expect(job(env).status).toBe("failed");
    expect(uploaded(env).length).toBeGreaterThan(0); // nothing rolled back
    expect(noLeak([res, job(env)])).toEqual([]);
  });

  it("sync-item write fails → failed/INTERNAL_ERROR; the image ledger is untouched for unprocessed items", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.db.repo.recordItem;
    env.deps.jobs = {
      ...env.db.repo,
      recordItem: vi.fn(async (...a: Parameters<typeof real>) => {
        if (a[3].drive_folder_name === "Durres")
          throw new Error(`insert failed ${DB_SECRET}`);
        return real(...a);
      }),
    };
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    });
    expect(uploaded(env)).toEqual([
      "milano1jpgxxxxx",
      "milano2jpgxxxxx",
      "milano3jpgxxxxx",
    ]);
    expect(env.db.images.some((r) => r.driveFileId === "durres1jpgxxxxx")).toBe(
      false,
    );
    expect(noLeak(res)).toEqual([]);
  });

  it("finish() fails after a successful run → the run rejects; the job stays running so its lease can expire and be reclaimed", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.deps.jobs = {
      ...env.db.repo,
      finish: vi.fn(async () => {
        throw new Error(`update failed ${DB_SECRET}`);
      }),
    };
    await expect(run(env)).rejects.toThrow();
    expect(job(env).status).toBe("running");
    expect(uploaded(env)).toHaveLength(4);
    // later: lease expires → another worker reclaims and completes WITHOUT re-uploading
    env.clock.now += 16 * 60_000;
    env.deps.jobs = env.db.repo;
    env.upload.mockClear();
    env.download.mockClear();
    const again = await run(env);
    expect(again.status).toBe("completed");
    expect(env.upload).not.toHaveBeenCalled();
    expect(env.download).not.toHaveBeenCalled();
    expect(job(env).progress).toMatchObject({ uploaded: 0, skipped: 4 });
  });

  it("database down for the whole run (first heartbeat fails) → rejects without scanning or touching Drive/Shopify", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.deps.jobs = {
      ...env.db.repo,
      heartbeat: vi.fn(async () => {
        throw new Error(`ECONNREFUSED ${DB_SECRET}`);
      }),
    };
    await expect(run(env)).rejects.toThrow();
    expect(env.scan).not.toHaveBeenCalled();
    expect(env.download).not.toHaveBeenCalled();
    expect(env.upload).not.toHaveBeenCalled();
  });

  it("image-ledger (sync_images) read fails → failed/INTERNAL_ERROR, nothing downloaded for that product", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.deps.jobs = {
      ...env.db.repo,
      imageStates: vi.fn(async () => {
        throw new Error("Could not read image states");
      }),
    };
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    });
    expect(env.download).not.toHaveBeenCalled();
  });

  it("a failing logger never prevents the job from being finished", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("EPIPE: stdout closed");
    });
    env.deps.jobs = {
      ...env.db.repo,
      recordItem: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "INTERNAL_ERROR",
    });
    expect(job(env).status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
describe("background launch (lib/sync/launch.ts)", () => {
  async function launchWith(opts: {
    deps?: () => unknown;
    run?: () => Promise<unknown>;
  }) {
    vi.resetModules();
    const callbacks: (() => Promise<void>)[] = [];
    vi.doMock("next/server", async (orig) => ({
      ...(await orig<typeof import("next/server")>()),
      after: (cb: () => Promise<void>) => void callbacks.push(cb),
    }));
    vi.doMock("@/lib/sync/runtime", () => ({
      getWorkerDeps: opts.deps ?? (() => ({})),
    }));
    vi.doMock("@/lib/sync/worker", () => ({
      runSyncJob: vi.fn(opts.run ?? (async () => ({ status: "completed" }))),
    }));
    const { launchSyncWorker } = await import("@/lib/sync/launch");
    launchSyncWorker({
      jobId: W_JOB,
      workspaceId: W_WS,
      workerId: "n8n-worker-test-1",
    });
    expect(callbacks).toHaveLength(1); // nothing runs before the response is sent
    await callbacks[0]!();
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/sync/runtime");
    vi.doUnmock("@/lib/sync/worker");
  }

  it("success is logged with the job id and status only", async () => {
    await launchWith({});
    expect(logs).toContain(`[sync-worker] job ${W_JOB} finished: completed`);
  });

  it("worker crash → caught and logged by error class only (no message, no secret)", async () => {
    await launchWith({
      run: async () => {
        throw new TypeError(`bad ${DB_SECRET} shpat_SECRET`);
      },
    });
    expect(logs.join("\n")).toContain(
      `[sync-worker] job ${W_JOB} crashed: TypeError`,
    );
    expect(noLeak(null)).toEqual([]);
  });

  it("missing configuration (getWorkerDeps throws) → caught, nothing unhandled", async () => {
    await launchWith({
      deps: () => {
        throw Object.assign(
          new Error("SUPABASE_SECRET_KEY missing sb_secret_X"),
          { name: "AdminClientConfigError" },
        );
      },
    });
    expect(logs.join("\n")).toContain("crashed: AdminClientConfigError");
    expect(logs.join("\n")).not.toContain("sb_secret_");
  });

  it("a failing logger inside the background task never throws out of after()", async () => {
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error("EPIPE");
    });
    await expect(
      launchWith({
        run: async () => {
          throw new Error("x");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("concurrency and leases", () => {
  it("two workers started at once on the same job → exactly one processes it", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const [a, b] = await Promise.all([run(env), run(env)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["completed", "not_claimed"]);
    expect(env.upload).toHaveBeenCalledTimes(4);
  });

  it("a pre-claimed worker (the /run path) whose lease was taken over stops at its first checkpoint", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob({
      status: "running",
      worker_id: "someone-else-01",
      heartbeat_at: env.clock.now,
    });
    const res = await run(env, "n8n-late-worker-01");
    expect(res.status).toBe("lost_lease");
    expect(env.scan).not.toHaveBeenCalled();
    expect(job(env).worker_id).toBe("someone-else-01");
  });
});

// ---------------------------------------------------------------------------
describe("Drive / Shopify resources changing mid-run", () => {
  it("Drive file deleted between scan and download → that image fails, the job continues (completed_with_errors)", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.download.getMockImplementation()!;
    env.download.mockImplementation(async (c) => {
      if (c.fileId === "milano2jpgxxxxx")
        throw new DriveDownloadError("DRIVE_FILE_NOT_FOUND");
      return real(c);
    });
    const res = await run(env);
    expect(res.status).toBe("completed_with_errors");
    expect(uploaded(env).sort()).toEqual([
      "durres1jpgxxxxx",
      "milano1jpgxxxxx",
      "milano3jpgxxxxx",
    ]);
    expect(
      (job(env).result!.failed_items as { code: string }[])[0],
    ).toMatchObject({ code: "DRIVE_FILE_NOT_FOUND" });
  });

  it("access to one file removed (PERMISSION_DENIED) → that image fails, others continue", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.download.getMockImplementation()!;
    env.download.mockImplementation(async (c) => {
      if (c.fileId === "durres1jpgxxxxx")
        throw new DriveDownloadError("PERMISSION_DENIED");
      return real(c);
    });
    const res = await run(env);
    expect(res.status).toBe("completed_with_errors");
    expect(uploaded(env)).toHaveLength(3);
  });

  it("category root un-shared / trashed mid-run → job STOPS (failed, DRIVE_ROOT_INACCESSIBLE); remaining images are NOT poisoned in the ledger", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.download.getMockImplementation()!;
    let n = 0;
    env.download.mockImplementation(async (c) => {
      if (++n >= 2) throw new DriveDownloadError("DRIVE_ROOT_INACCESSIBLE");
      return real(c);
    });
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "DRIVE_ROOT_INACCESSIBLE",
    });
    expect(uploaded(env)).toEqual(["milano1jpgxxxxx"]);
    expect(
      env.db.images.filter((r) => r.uploadStatus === "failed"),
    ).toHaveLength(0);
    // access restored → next run uploads the rest
    env.download.mockImplementation(real);
    env.db.addJob();
    const again = await run(env);
    expect(again.status).toBe("completed");
    expect(uploaded(env).sort()).toEqual([
      "durres1jpgxxxxx",
      "milano1jpgxxxxx",
      "milano2jpgxxxxx",
      "milano3jpgxxxxx",
    ]);
  });

  it("Google disconnected / token revoked mid-run → job stops (failed), completed uploads kept", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.download.getMockImplementation()!;
    let n = 0;
    env.download.mockImplementation(async (c) => {
      if (++n === 3) throw new DriveDownloadError("GOOGLE_DRIVE_NOT_CONNECTED");
      return real(c);
    });
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "GOOGLE_DRIVE_NOT_CONNECTED",
    });
    expect(uploaded(env)).toHaveLength(2);
    expect(
      env.db.images.filter((r) => r.uploadStatus === "failed"),
    ).toHaveLength(0);
  });

  it("Shopify product deleted between scan and upload → that product's images fail (permanent), others continue", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    const real = env.upload.getMockImplementation()!;
    env.upload.mockImplementation(async (input, d) =>
      input.shopifyProductId === "gid://shopify/Product/1"
        ? ({
            status: "failed",
            productId: input.shopifyProductId,
            mediaId: null,
            error: {
              code: "PRODUCT_NOT_FOUND",
              message: "The Shopify product no longer exists.",
              retryable: false,
            },
          } as UploadProductImageResult)
        : real(input, d),
    );
    const res = await run(env);
    expect(res.status).toBe("completed_with_errors");
    expect(
      env.upload.mock.calls.filter(
        (c) => c[0].shopifyProductId === "gid://shopify/Product/1",
      ),
    ).toHaveLength(3); // no retries
    expect(uploaded(env)).toEqual(["durres1jpgxxxxx"]);
    expect(job(env).progress).toMatchObject({ failed: 3, uploaded: 1 });
  });

  it("Shopify throttled on every attempt → bounded retries (3) then the job stops safely", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.upload.mockImplementation(
      async (input) =>
        ({
          status: "failed",
          productId: input.shopifyProductId,
          mediaId: null,
          error: {
            code: "SHOPIFY_THROTTLED",
            message: "Throttled",
            retryable: true,
            retryAfterSeconds: 2,
          },
        }) as UploadProductImageResult,
    );
    const res = await run(env);
    expect(res).toMatchObject({
      status: "failed",
      errorCode: "SHOPIFY_THROTTLED",
    });
    expect(env.upload).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(env.deps.sleep!).mock.calls.every((c) => c[0] <= 30_000),
    ).toBe(true);
  });

  it("Drive unavailable with a huge Retry-After → the wait is capped (30 s), never unbounded", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.download.mockRejectedValue(
      new DriveDownloadError("GOOGLE_DRIVE_UNAVAILABLE", {
        retryAfterSeconds: 86_400,
      }),
    );
    await run(env);
    expect(env.download).toHaveBeenCalledTimes(3);
    expect(vi.mocked(env.deps.sleep!).mock.calls.map((c) => c[0])).toEqual([
      30_000, 30_000,
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("permanent errors are never retried forever", () => {
  it("a retryable failure that has already used 5 attempts is BLOCKED: no download, no upload", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.db.images.push({
      id: "img-exhausted",
      storeId: W_STORE,
      shopifyProductId: "gid://shopify/Product/1",
      driveFileId: "milano1jpgxxxxx",
      shopifyMediaId: null,
      uploadStatus: "failed",
      errorCode: "SHOPIFY_UNAVAILABLE",
      retryable: true,
      attemptCount: 5,
      checksum: "md5-milano1jpgxxxxx",
      driveModifiedAt: "2026-09-01T00:00:00.000Z",
      filename: "1.jpg",
      lastAttemptAt: env.clock.now - 3_600_000,
    });
    await run(env);
    expect(env.download.mock.calls.map((c) => c[0].fileId)).not.toContain(
      "milano1jpgxxxxx",
    );
    expect(env.upload.mock.calls.map((c) => c[0].driveFileId)).not.toContain(
      "milano1jpgxxxxx",
    );
    expect(job(env).result!.blocked).toBe(1);
  });

  it("…but a CHANGED file (new checksum) is uploaded again even after being blocked", () => {
    const state = {
      driveFileId: "f",
      uploadStatus: "failed",
      checksum: "old",
      driveModifiedAt: null,
      shopifyMediaId: null,
      retryable: false,
      attemptCount: 5,
      lastAttemptAt: null,
    };
    expect(
      predictImageAction(state, { md5Checksum: "old", modifiedTime: null }, 0),
    ).toBe("blocked");
    expect(
      predictImageAction(state, { md5Checksum: "new", modifiedTime: null }, 0),
    ).toBe("upload");
  });

  it("results and logs of all of the above never contain secrets or image bytes", async () => {
    const env = workerEnv(oneRoot());
    env.db.addJob();
    env.download.mockRejectedValueOnce(
      new DriveDownloadError("PERMISSION_DENIED"),
    );
    env.deps.jobs = {
      ...env.db.repo,
      finish: vi.fn(async (i) => {
        expect(noLeak(i)).toEqual([]);
        return env.db.repo.finish(i);
      }),
    };
    await run(env);
    expect(noLeak([job(env), env.db.items, env.db.images])).toEqual([]);
  });
});
