import { n8nRoute } from "@/lib/n8n/handler";
import { requireUuid } from "@/lib/n8n/validation";

export const dynamic = "force-dynamic";

/** GET /api/n8n/v1/sync-jobs/:jobId — scope n8n:jobs. */
export const GET = n8nRoute<{ jobId: string }>(
  "GET /sync-jobs/:jobId",
  { scope: "n8n:jobs", rate: "read" },
  async ({ key, repo }, { jobId }) => ({ body: await repo.getJob(key.id, requireUuid(jobId, "JOB_NOT_FOUND")) }),
);
