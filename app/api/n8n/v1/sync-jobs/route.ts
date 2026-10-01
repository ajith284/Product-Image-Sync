import { N8nApiError } from "@/lib/n8n/errors";
import { n8nRoute, parseJsonBody } from "@/lib/n8n/handler";
import {
  decodeCursor,
  encodeCursor,
  IDEMPOTENCY_KEY_RE,
  JOB_STATUSES,
  parseCreateJob,
  requestHash,
  requireUuid,
} from "@/lib/n8n/validation";

export const dynamic = "force-dynamic";

/**
 * POST /api/n8n/v1/sync-jobs — scope n8n:sync. QUEUES a job only (no sync runs).
 * Requires Idempotency-Key: a retry with the same key + body returns the
 * original job (200, Idempotent-Replayed: true) instead of creating another.
 */
export const POST = n8nRoute(
  "POST /sync-jobs",
  { scope: "n8n:sync", rate: "write" },
  async ({ key, repo, rawBody, requestId, headers }) => {
    const idempotencyKey = headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new N8nApiError("IDEMPOTENCY_KEY_REQUIRED");
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new N8nApiError("INVALID_REQUEST", { message: "Idempotency-Key must be 1-200 chars of A-Z a-z 0-9 . _ : -" });
    }
    const body = parseCreateJob(parseJsonBody(rawBody));
    const options: Record<string, string> = {};
    if (body.category) options.category = body.category;
    if (body.folder_id) options.folder_id = body.folder_id;

    const { job, replayed } = await repo.createJob({
      keyId: key.id,
      storeId: body.store_id.toLowerCase(),
      trigger: body.trigger_source,
      dryRun: body.dry_run,
      options,
      idempotencyKey,
      requestHash: requestHash(body),
      requestId,
    });
    return {
      status: replayed ? 200 : 201,
      body: job,
      headers: { "Idempotent-Replayed": replayed ? "true" : "false" },
    };
  },
);

/** GET /api/n8n/v1/sync-jobs?store_id&status&limit&cursor — scope n8n:jobs. Newest first, keyset pages. */
export const GET = n8nRoute("GET /sync-jobs", { scope: "n8n:jobs", rate: "read" }, async ({ key, repo, url }) => {
  const q = url.searchParams;
  const storeId = q.get("store_id") ? requireUuid(q.get("store_id")!, "STORE_NOT_FOUND") : null;
  const status = q.get("status");
  if (status && !(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new N8nApiError("INVALID_REQUEST", { message: "Invalid status." });
  }
  const limitRaw = q.get("limit") ?? "20";
  const limit = /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!(limit >= 1 && limit <= 100)) throw new N8nApiError("INVALID_REQUEST", { message: "limit must be 1-100." });

  const rows = await repo.listJobs({ keyId: key.id, storeId, status, limit, cursor: decodeCursor(q.get("cursor")) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    body: { data: page, next_cursor: rows.length > limit && last ? encodeCursor(last) : null },
  };
});
