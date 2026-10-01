import { randomUUID } from "node:crypto";

import { n8nRoute, parseJsonBody } from "@/lib/n8n/handler";
import { requireUuid } from "@/lib/n8n/validation";
import { launchSyncWorker } from "@/lib/sync/launch";

export const dynamic = "force-dynamic";
/** The worker runs after the response, inside this route's time budget (self-hosted: no limit). */
export const maxDuration = 800;

/**
 * POST /api/n8n/v1/sync-jobs/:jobId/run — scope n8n:sync (Prompt 13).
 *
 * Claims the job for ONE worker and starts it in the background:
 *   202 { ...job, claimed: true,  reason: "claimed" | "reclaimed" }   worker started
 *   200 { ...job, claimed: false, reason: "already_running" }         another worker holds the lease
 *   200 { ...job, claimed: false, reason: "finished" }                job already terminal
 * The job's workspace / store come from the database (API key → workspace → store
 * restriction → job). The body is ignored: no tokens, store IDs or options are accepted.
 */
export const POST = n8nRoute<{ jobId: string }>(
  "POST /sync-jobs/:jobId/run",
  { scope: "n8n:sync", rate: "write" },
  async ({ key, repo, rawBody, requestId }, { jobId }) => {
    parseJsonBody(rawBody); // optional; malformed JSON is still rejected
    const id = requireUuid(jobId, "JOB_NOT_FOUND");
    const workerId = `n8n-${randomUUID()}`;
    const { job, claimed, reason } = await repo.startJob(
      key.id,
      id,
      requestId,
      workerId,
    );
    if (claimed)
      launchSyncWorker({ jobId: id, workspaceId: key.workspaceId, workerId });
    return { status: claimed ? 202 : 200, body: { ...job, claimed, reason } };
  },
);
