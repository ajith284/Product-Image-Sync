import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import { N8nApiError } from "@/lib/n8n/errors";
import { generateApiKey, type ApiScope } from "@/lib/n8n/keys";
import type { JobJson, N8nRepository, StoredApiKey } from "@/lib/n8n/repository";

export const WS_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const WS_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const STORE_A = "aaaaaaaa-0000-4000-8000-0000000000a1"; // BrandSure: ready
export const STORE_A2 = "aaaaaaaa-0000-4000-8000-0000000000a2"; // no root folder
export const STORE_B = "bbbbbbbb-0000-4000-8000-0000000000b1";

type Store = { id: string; workspaceId: string; name: string; shopify: boolean; drive: boolean; root: string | null };
type Job = JobJson & { workspace_id: string; idempotency_key: string | null; request_hash: string | null };

/**
 * In-memory repository mirroring the n8n_* SQL functions
 * (supabase/migrations/*_n8n_api.sql): key checks, store restriction,
 * idempotency per workspace, one active job per store, keyset pagination.
 */
export function fakeN8n() {
  const stores: Store[] = [
    { id: STORE_A, workspaceId: WS_A, name: "BrandSure", shopify: true, drive: true, root: "Sofa" },
    { id: STORE_A2, workspaceId: WS_A, name: "Second", shopify: true, drive: true, root: null },
    { id: STORE_B, workspaceId: WS_B, name: "Other", shopify: true, drive: true, root: "B" },
  ];
  const keys: (StoredApiKey & { prefix: string; revoked: boolean })[] = [];
  const jobs: Job[] = [];
  const nonces = new Set<string>();
  const buckets = new Map<string, number>();
  const limits = { override: null as null | number };

  function addKey(opts: { workspaceId?: string; storeId?: string | null; scopes?: ApiScope[]; name?: string } = {}) {
    const k = generateApiKey();
    keys.push({
      id: randomUUID(),
      prefix: k.prefix,
      workspaceId: opts.workspaceId ?? WS_A,
      storeId: opts.storeId ?? null,
      scopes: opts.scopes ?? ["n8n:read", "n8n:sync", "n8n:jobs"],
      secretHash: k.secretHash,
      name: opts.name ?? "n8n",
      revoked: false,
    });
    return { ...k, id: keys[keys.length - 1]!.id };
  }

  function check(keyId: string, scope: ApiScope | null, storeId: string | null) {
    const k = keys.find((x) => x.id === keyId && !x.revoked);
    if (!k) throw new N8nApiError("INVALID_API_KEY");
    if (scope && !k.scopes.includes(scope)) throw new N8nApiError("INSUFFICIENT_SCOPE");
    if (storeId) {
      if (k.storeId && k.storeId !== storeId) throw new N8nApiError("STORE_NOT_FOUND");
      if (!stores.some((s) => s.id === storeId && s.workspaceId === k.workspaceId)) throw new N8nApiError("STORE_NOT_FOUND");
    }
    return k;
  }

  const view = (j: Job): JobJson => {
    const { workspace_id: _w, idempotency_key: _i, request_hash: _h, ...rest } = j;
    void _w;
    void _i;
    void _h;
    return { ...rest };
  };

  const repo: N8nRepository = {
    authenticate: vi.fn(async (prefix: string) => {
      const k = keys.find((x) => x.prefix === prefix && !x.revoked);
      return k ? { id: k.id, workspaceId: k.workspaceId, storeId: k.storeId, scopes: k.scopes, secretHash: k.secretHash, name: k.name } : null;
    }),
    touch: vi.fn(async () => undefined),
    rateLimit: vi.fn(async (bucket: string, limit: number) => {
      const n = (buckets.get(bucket) ?? 0) + 1;
      buckets.set(bucket, n);
      return { allowed: n <= (limits.override ?? limit), retryAfter: 42 };
    }),
    useNonce: vi.fn(async (keyId: string, nonce: string) => {
      const id = `${keyId}:${nonce}`;
      if (nonces.has(id)) return false;
      nonces.add(id);
      return true;
    }),
    storeStatus: vi.fn(async (keyId: string, storeId: string) => {
      check(keyId, "n8n:read", storeId);
      const s = stores.find((x) => x.id === storeId)!;
      return {
        store_id: s.id,
        store_name: s.name,
        shopify: { connected: s.shopify, status: s.shopify ? "connected" : "not_connected", shop_domain: "psvft1-0d.myshopify.com", last_verified_at: "2026-10-01T08:00:00Z" },
        google_drive: {
          connected: s.drive,
          status: s.drive ? "connected" : "not_connected",
          root_folder_selected: Boolean(s.root),
          root_folder_id: s.root ? "sofaFolderId001" : null,
          root_folder_name: s.root,
          last_verified_at: "2026-10-01T08:00:00Z",
        },
        ready_for_sync: s.shopify && s.drive && Boolean(s.root),
      };
    }),
    createJob: vi.fn(async (i) => {
      const k = check(i.keyId, "n8n:sync", i.storeId);
      const existing = jobs.find((j) => j.workspace_id === k.workspaceId && j.idempotency_key === i.idempotencyKey);
      if (existing) {
        if (existing.store_id === i.storeId && existing.request_hash === i.requestHash) return { job: view(existing), replayed: true };
        throw new N8nApiError("IDEMPOTENCY_CONFLICT");
      }
      const s = stores.find((x) => x.id === i.storeId)!;
      if (!s.shopify) throw new N8nApiError("SHOPIFY_NOT_CONNECTED");
      if (!s.drive) throw new N8nApiError("GOOGLE_DRIVE_NOT_CONNECTED");
      if (!s.root) throw new N8nApiError("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
      const active = jobs.find((j) => j.store_id === i.storeId && ["queued", "running"].includes(j.status));
      if (active) throw new N8nApiError("SYNC_JOB_ALREADY_ACTIVE", { extra: { active_job_id: active.job_id } });
      const job: Job = {
        job_id: randomUUID(),
        store_id: i.storeId,
        workspace_id: k.workspaceId,
        status: "queued",
        trigger_source: i.trigger,
        dry_run: i.dryRun,
        options: i.options,
        cancel_requested: false,
        progress: { total: 0, processed: 0, uploaded: 0, skipped: 0, review: 0, failed: 0 },
        error: null,
        created_at: new Date(Date.now() + jobs.length).toISOString(),
        started_at: null,
        completed_at: null,
        cancelled_at: null,
        idempotency_key: i.idempotencyKey,
        request_hash: i.requestHash,
      };
      jobs.push(job);
      return { job: view(job), replayed: false };
    }),
    getJob: vi.fn(async (keyId: string, jobId: string) => {
      const k = check(keyId, "n8n:jobs", null);
      const j = jobs.find((x) => x.job_id === jobId && x.workspace_id === k.workspaceId && (!k.storeId || x.store_id === k.storeId));
      if (!j) throw new N8nApiError("JOB_NOT_FOUND");
      return view(j);
    }),
    listJobs: vi.fn(async ({ keyId, storeId, status, limit, cursor }) => {
      const k = check(keyId, "n8n:jobs", storeId);
      return jobs
        .filter((j) => j.workspace_id === k.workspaceId && (!k.storeId || j.store_id === k.storeId))
        .filter((j) => (!storeId || j.store_id === storeId) && (!status || j.status === status))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.job_id < b.job_id ? 1 : -1))
        .filter((j) => !cursor || j.created_at < cursor.createdAt || (j.created_at === cursor.createdAt && j.job_id < cursor.id))
        .slice(0, limit + 1)
        .map(view);
    }),
    cancelJob: vi.fn(async (keyId: string, jobId: string) => {
      const k = check(keyId, "n8n:jobs", null);
      const j = jobs.find((x) => x.job_id === jobId && x.workspace_id === k.workspaceId && (!k.storeId || x.store_id === k.storeId));
      if (!j) throw new N8nApiError("JOB_NOT_FOUND");
      if (j.status === "cancelled") return { job: view(j), changed: false };
      if (!["queued", "running"].includes(j.status)) throw new N8nApiError("JOB_NOT_CANCELLABLE");
      if (j.status === "queued") {
        j.status = "cancelled";
        j.cancelled_at = new Date().toISOString();
      } else j.cancel_requested = true;
      return { job: view(j), changed: true };
    }),
    startJob: vi.fn(async (keyId: string, jobId: string, _requestId: string, workerId: string) => {
      const k = check(keyId, "n8n:sync", null);
      const j = jobs.find((x) => x.job_id === jobId && x.workspace_id === k.workspaceId && (!k.storeId || x.store_id === k.storeId));
      if (!j) throw new N8nApiError("JOB_NOT_FOUND");
      const w = j as Job & { worker_id?: string };
      if (j.status === "queued") {
        j.status = "running";
        j.started_at = new Date().toISOString();
        w.worker_id = workerId;
        return { job: view(j), claimed: true, reason: "claimed" as const };
      }
      if (j.status === "running") return { job: view(j), claimed: false, reason: "already_running" as const };
      return { job: view(j), claimed: false, reason: "finished" as const };
    }),
  };

  return { repo, keys, jobs, stores, addKey, limits, buckets };
}
