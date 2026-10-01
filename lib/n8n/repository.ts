import "server-only";

import { N8nApiError, SQL_ERROR_MAP } from "@/lib/n8n/errors";
import type { ApiScope } from "@/lib/n8n/keys";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Data access for the machine API. Every call is a service-role-only SECURITY
 * DEFINER function (supabase/migrations/*_n8n_api.sql) that re-checks the API
 * key (active, scope, workspace, store restriction) itself.
 */

export type StoredApiKey = {
  id: string;
  workspaceId: string;
  storeId: string | null;
  scopes: ApiScope[];
  secretHash: string;
  name: string;
};

export type JobJson = Record<string, unknown> & { job_id: string; store_id: string; status: string; created_at: string };

export type CreateJobInput = {
  keyId: string;
  storeId: string;
  trigger: "n8n" | "scheduled" | "api";
  dryRun: boolean;
  options: Record<string, string>;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
};

export interface N8nRepository {
  authenticate(prefix: string): Promise<StoredApiKey | null>;
  touch(keyId: string): Promise<void>;
  rateLimit(bucket: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }>;
  useNonce(keyId: string, nonce: string, ttlSeconds: number): Promise<boolean>;
  storeStatus(keyId: string, storeId: string): Promise<Record<string, unknown>>;
  createJob(input: CreateJobInput): Promise<{ job: JobJson; replayed: boolean }>;
  getJob(keyId: string, jobId: string): Promise<JobJson>;
  listJobs(input: {
    keyId: string;
    storeId: string | null;
    status: string | null;
    limit: number;
    cursor: { createdAt: string; id: string } | null;
  }): Promise<JobJson[]>;
  cancelJob(keyId: string, jobId: string, requestId: string): Promise<{ job: JobJson; changed: boolean }>;
  /** Claims the job for one worker (Prompt 13). Not claimed → reason already_running | finished. */
  startJob(
    keyId: string,
    jobId: string,
    requestId: string,
    workerId: string,
  ): Promise<{ job: JobJson; claimed: boolean; reason: "claimed" | "reclaimed" | "already_running" | "finished" }>;
}

type PgError = { message?: string; details?: string | null } | null;

function fail(error: PgError): never {
  const code = SQL_ERROR_MAP[error?.message?.trim() ?? ""];
  if (!code) throw new N8nApiError("INTERNAL_ERROR"); // never leak DB errors
  if (code === "SYNC_JOB_ALREADY_ACTIVE" && error?.details && /^[0-9a-f-]{36}$/.test(error.details)) {
    throw new N8nApiError(code, { extra: { active_job_id: error.details } });
  }
  throw new N8nApiError(code);
}

export function createN8nRepository(): N8nRepository {
  const db = createAdminClient();

  return {
    async authenticate(prefix) {
      const { data, error } = await db.rpc("n8n_authenticate", { p_key_prefix: prefix });
      if (error) fail(error);
      const row = data?.[0];
      if (!row) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        storeId: row.store_id,
        scopes: row.scopes as ApiScope[],
        secretHash: row.secret_hash,
        name: row.name,
      };
    },

    async touch(keyId) {
      await db.rpc("n8n_touch_api_key", { p_key_id: keyId });
    },

    async rateLimit(bucket, limit, windowSeconds) {
      const { data, error } = await db.rpc("n8n_rate_limit_hit", {
        p_bucket: bucket,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) fail(error);
      const row = data?.[0];
      return { allowed: row?.allowed !== false, retryAfter: row?.retry_after ?? windowSeconds };
    },

    async useNonce(keyId, nonce, ttlSeconds) {
      const { data, error } = await db.rpc("n8n_use_nonce", { p_key_id: keyId, p_nonce: nonce, p_ttl_seconds: ttlSeconds });
      if (error) fail(error);
      return data === true;
    },

    async storeStatus(keyId, storeId) {
      const { data, error } = await db.rpc("n8n_store_status", { p_key_id: keyId, p_store_id: storeId });
      if (error) fail(error);
      return data as Record<string, unknown>;
    },

    async createJob(i) {
      const { data, error } = await db.rpc("n8n_create_sync_job", {
        p_key_id: i.keyId,
        p_store_id: i.storeId,
        p_trigger: i.trigger,
        p_dry_run: i.dryRun,
        p_options: i.options as Json,
        p_idempotency_key: i.idempotencyKey,
        p_request_hash: i.requestHash,
        p_request_id: i.requestId,
      });
      if (error) fail(error);
      const row = data?.[0];
      if (!row) throw new N8nApiError("INTERNAL_ERROR");
      return { job: row.job as JobJson, replayed: row.replayed === true };
    },

    async getJob(keyId, jobId) {
      const { data, error } = await db.rpc("n8n_get_sync_job", { p_key_id: keyId, p_job_id: jobId });
      if (error) fail(error);
      return data as JobJson;
    },

    async listJobs({ keyId, storeId, status, limit, cursor }) {
      const { data, error } = await db.rpc("n8n_list_sync_jobs", {
        p_key_id: keyId,
        p_store_id: storeId ?? undefined,
        p_status: status ?? undefined,
        p_limit: limit,
        p_cursor_created_at: cursor?.createdAt ?? undefined,
        p_cursor_id: cursor?.id ?? undefined,
      });
      if (error) fail(error);
      return (data ?? []) as JobJson[];
    },

    async cancelJob(keyId, jobId, requestId) {
      const { data, error } = await db.rpc("n8n_cancel_sync_job", { p_key_id: keyId, p_job_id: jobId, p_request_id: requestId });
      if (error) fail(error);
      const row = data?.[0];
      if (!row) throw new N8nApiError("INTERNAL_ERROR");
      return { job: row.job as JobJson, changed: row.changed === true };
    },
    async startJob(keyId, jobId, requestId, workerId) {
      const { data, error } = await db.rpc("n8n_start_sync_job", {
        p_key_id: keyId,
        p_job_id: jobId,
        p_request_id: requestId,
        p_worker_id: workerId,
      });
      if (error) fail(error);
      const row = data?.[0];
      if (!row) throw new N8nApiError("INTERNAL_ERROR");
      return {
        job: row.job as JobJson,
        claimed: row.claimed === true,
        reason: row.reason as "claimed" | "reclaimed" | "already_running" | "finished",
      };
    },
  };
}
