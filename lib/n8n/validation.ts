import "server-only";

import { z } from "zod";

import { N8nApiError } from "@/lib/n8n/errors";
import { sha256Hex } from "@/lib/n8n/keys";

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

export function requireUuid(value: string | undefined, notFound: "STORE_NOT_FOUND" | "JOB_NOT_FOUND"): string {
  // Malformed IDs get the same answer as foreign ones: no enumeration.
  if (!value || !z.uuid().safeParse(value).success) throw new N8nApiError(notFound);
  return value.toLowerCase();
}

/**
 * POST /sync-jobs body. STRICT: unknown fields (workspace_id, credentials, …)
 * are rejected — authorization comes only from the API key.
 */
export const createJobSchema = z
  .object({
    store_id: z.uuid(),
    trigger_source: z.enum(["n8n", "scheduled", "api"]).default("n8n"),
    dry_run: z.boolean().default(false),
    category: z.string().trim().min(1).max(100).optional(),
    folder_id: z.string().regex(DRIVE_ID_RE).optional(),
  })
  .strict();

export type CreateJobBody = z.infer<typeof createJobSchema>;

export function parseCreateJob(body: unknown): CreateJobBody {
  const r = createJobSchema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue?.path.join(".") || (issue && "keys" in issue ? String((issue as { keys?: string[] }).keys?.[0]) : "");
    throw new N8nApiError("INVALID_REQUEST", {
      message: issue?.code === "unrecognized_keys" ? `Unknown field: ${field}.` : `Invalid field: ${field || "body"}.`,
    });
  }
  return r.data;
}

/** Stable hash of the meaningful request fields (idempotency comparison). */
export function requestHash(b: CreateJobBody): string {
  return sha256Hex(
    JSON.stringify({
      store_id: b.store_id.toLowerCase(),
      trigger_source: b.trigger_source,
      dry_run: b.dry_run,
      category: b.category ?? null,
      folder_id: b.folder_id ?? null,
    }),
  );
}

export function encodeCursor(job: { created_at: string; job_id: string }): string {
  return Buffer.from(`${job.created_at}|${job.job_id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string | null): { createdAt: string; id: string } | null {
  if (!value) return null;
  const raw = Buffer.from(value, "base64url").toString("utf8");
  const [createdAt, id] = raw.split("|");
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !z.uuid().safeParse(id).success) {
    throw new N8nApiError("INVALID_REQUEST", { message: "Invalid cursor." });
  }
  return { createdAt, id };
}

export const JOB_STATUSES = ["queued", "running", "completed", "completed_with_errors", "failed", "cancelled"] as const;
