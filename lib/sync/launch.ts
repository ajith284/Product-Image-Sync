import "server-only";

import { after } from "next/server";

import { getWorkerDeps } from "@/lib/sync/runtime";
import { runSyncJob } from "@/lib/sync/worker";

/**
 * Runs an already-claimed job after the HTTP response has been sent (Next.js `after()`).
 * The response never waits for Drive/Shopify. If the process dies, the lease
 * (heartbeat_at) expires and POST /run can re-claim the job (crash recovery).
 */
export function launchSyncWorker(input: {
  jobId: string;
  workspaceId: string;
  workerId: string;
}) {
  after(async () => {
    try {
      const result = await runSyncJob(input, getWorkerDeps());
      log("info", `[sync-worker] job ${input.jobId} finished: ${result.status}`);
    } catch (error) {
      // Codes/class names only — never tokens or payloads.
      log("error", `[sync-worker] job ${input.jobId} crashed: ${error instanceof Error ? error.name : "error"}`);
    }
  });
}

/** A failing logger must never turn into an unhandled rejection inside after(). */
function log(level: "info" | "error", line: string) {
  try {
    console[level](line);
  } catch {
    // ignore
  }
}
