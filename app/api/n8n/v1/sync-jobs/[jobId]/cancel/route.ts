import { n8nRoute, parseJsonBody } from "@/lib/n8n/handler";
import { requireUuid } from "@/lib/n8n/validation";

export const dynamic = "force-dynamic";

/**
 * POST /api/n8n/v1/sync-jobs/:jobId/cancel — scope n8n:jobs.
 * queued → cancelled; running → cancel requested (the worker stops later).
 * Idempotent: cancelling again returns 200 with "changed": false.
 */
export const POST = n8nRoute<{ jobId: string }>(
  "POST /sync-jobs/:jobId/cancel",
  { scope: "n8n:jobs", rate: "write" },
  async ({ key, repo, rawBody, requestId }, { jobId }) => {
    parseJsonBody(rawBody); // body is optional; malformed JSON is still rejected
    const { job, changed } = await repo.cancelJob(key.id, requireUuid(jobId, "JOB_NOT_FOUND"), requestId);
    return { body: { ...job, changed } };
  },
);
