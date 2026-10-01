import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalString, generateApiKey, parseApiToken, sha256Hex, signRequest } from "@/lib/n8n/keys";
import { isPublicPath } from "@/lib/routes";
import { fakeN8n, STORE_A, STORE_A2, STORE_B, WS_B } from "./helpers/fake-n8n";

const mocks = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("@/lib/n8n/runtime", () => ({ getN8nRepository: () => mocks.repo }));

const health = await import("@/app/api/n8n/v1/health/route");
const status = await import("@/app/api/n8n/v1/stores/[storeId]/status/route");
const jobsRoute = await import("@/app/api/n8n/v1/sync-jobs/route");
const jobRoute = await import("@/app/api/n8n/v1/sync-jobs/[jobId]/route");
const cancelRoute = await import("@/app/api/n8n/v1/sync-jobs/[jobId]/cancel/route");

const BASE = "https://reach-rental-heat.ngrok-free.dev/api/n8n/v1";
let env: ReturnType<typeof fakeN8n>;
let key: ReturnType<ReturnType<typeof fakeN8n>["addKey"]>;
let logs: string[];

beforeEach(() => {
  env = fakeN8n();
  mocks.repo = env.repo;
  key = env.addKey();
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Opts = { token?: string | null; body?: unknown; headers?: Record<string, string>; method?: string };
function req(path: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? key.token}`;
  let body: string | undefined;
  if (o.body !== undefined) {
    body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
    headers["content-type"] ??= "application/json";
  }
  return new NextRequest(`${BASE}${path}`, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const getStatus = (storeId: string, o: Opts = {}) => status.GET(req(`/stores/${storeId}/status`, o), params({ storeId }));
const createJob = (body: unknown, idem: string | null = "idem-1", o: Opts = {}) =>
  jobsRoute.POST(req("/sync-jobs", { body, ...o, headers: { ...(idem ? { "idempotency-key": idem } : {}), ...(o.headers ?? {}) } }));
const getJob = (jobId: string, o: Opts = {}) => jobRoute.GET(req(`/sync-jobs/${jobId}`, o), params({ jobId }));
const cancel = (jobId: string, o: Opts = {}) =>
  cancelRoute.POST(req(`/sync-jobs/${jobId}/cancel`, { method: "POST", ...o }), params({ jobId }));

async function errorOf(res: Response) {
  const body = await res.json();
  return { status: res.status, code: body.error?.code, body };
}

describe("authentication", () => {
  it("1. valid API key → 200", async () => {
    const res = await getStatus(STORE_A);
    expect(res.status).toBe(200);
    expect(env.repo.touch).toHaveBeenCalled();
  });

  it("2. invalid API key (right prefix, wrong secret) → 401", async () => {
    const bad = `${parseApiToken(key.token)!.prefix}_${"A".repeat(43)}`;
    expect(await errorOf(await getStatus(STORE_A, { token: bad }))).toMatchObject({ status: 401, code: "INVALID_API_KEY" });
  });

  it("2b. malformed / unknown token → 401", async () => {
    expect((await errorOf(await getStatus(STORE_A, { token: "nope" }))).status).toBe(401);
    expect((await errorOf(await getStatus(STORE_A, { token: generateApiKey().token }))).status).toBe(401);
  });

  it("3/5. revoked (or expired) key stops working immediately → 401", async () => {
    expect((await getStatus(STORE_A)).status).toBe(200);
    env.keys[0]!.revoked = true;
    expect(await errorOf(await getStatus(STORE_A))).toMatchObject({ status: 401, code: "INVALID_API_KEY" });
  });

  it("4. missing API key → 401 with the standard error format + request id", async () => {
    const res = await getStatus(STORE_A, { token: null });
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body).toEqual({
      error: { code: "INVALID_API_KEY", message: "The API credential is missing, invalid, revoked or expired.", request_id: res.headers.get("x-request-id") },
    });
  });

  it("a browser session cookie can't impersonate n8n", async () => {
    const res = await getStatus(STORE_A, { token: null, headers: { cookie: "sb-xkzccfxrixpyozfhamdh-auth-token=base64-eyJ4IjoxfQ" } });
    expect(res.status).toBe(401);
  });

  it("the n8n namespace is public to the proxy (no login redirect); auth is the API key", () => {
    expect(isPublicPath("/api/n8n/v1/health")).toBe(true);
    expect(isPublicPath("/api/n8n/v1/sync-jobs")).toBe(true);
  });
});

describe("authorization", () => {
  it("6. workspace A key → workspace A store", async () => {
    const body = await (await getStatus(STORE_A)).json();
    expect(body.store_name).toBe("BrandSure");
  });

  it("7. workspace A key → workspace B store → 404", async () => {
    expect(await errorOf(await getStatus(STORE_B))).toMatchObject({ status: 404, code: "STORE_NOT_FOUND" });
  });

  it("8/9. store-restricted key → its store OK, other store 404", async () => {
    const restricted = env.addKey({ storeId: STORE_A });
    expect((await getStatus(STORE_A, { token: restricted.token })).status).toBe(200);
    expect(await errorOf(await getStatus(STORE_A2, { token: restricted.token }))).toMatchObject({ status: 404, code: "STORE_NOT_FOUND" });
  });

  it("10. insufficient scope → 403 (checked before touching data)", async () => {
    const readOnly = env.addKey({ scopes: ["n8n:read"] });
    expect(await errorOf(await createJob({ store_id: STORE_A }, "i1", { token: readOnly.token }))).toMatchObject({
      status: 403,
      code: "INSUFFICIENT_SCOPE",
    });
    expect(env.repo.createJob).not.toHaveBeenCalled();
    const syncOnly = env.addKey({ scopes: ["n8n:sync"] });
    expect((await getStatus(STORE_A, { token: syncOnly.token })).status).toBe(403);
  });
});

describe("idempotency", () => {
  it("11/12. first request creates (201); identical retry returns the original (200, replayed)", async () => {
    const r1 = await createJob({ store_id: STORE_A, trigger_source: "n8n" });
    const j1 = await r1.json();
    expect(r1.status).toBe(201);
    expect(r1.headers.get("idempotent-replayed")).toBe("false");
    expect(j1).toMatchObject({ status: "queued", store_id: STORE_A, progress: { total: 0, processed: 0, uploaded: 0, skipped: 0, review: 0, failed: 0 } });
    const r2 = await createJob({ store_id: STORE_A, trigger_source: "n8n" });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect((await r2.json()).job_id).toBe(j1.job_id);
    expect(env.jobs).toHaveLength(1);
  });

  it("13. same Idempotency-Key on a different store → 409", async () => {
    await createJob({ store_id: STORE_A });
    expect(await errorOf(await createJob({ store_id: STORE_A2 }))).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("same key, different body → 409; keys never cross workspaces", async () => {
    await createJob({ store_id: STORE_A });
    expect((await errorOf(await createJob({ store_id: STORE_A, dry_run: true }))).code).toBe("IDEMPOTENCY_CONFLICT");
    const bKey = env.addKey({ workspaceId: WS_B });
    expect((await createJob({ store_id: STORE_B }, "idem-1", { token: bKey.token })).status).toBe(201);
  });

  it("14. concurrent duplicate requests create exactly one job", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createJob({ store_id: STORE_A }, "same-key")));
    const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).job_id)));
    expect(ids.size).toBe(1);
    expect(env.jobs).toHaveLength(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it("Idempotency-Key is required and validated", async () => {
    expect(await errorOf(await createJob({ store_id: STORE_A }, null))).toMatchObject({ status: 422, code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect((await errorOf(await createJob({ store_id: STORE_A }, "bad key with spaces"))).status).toBe(422);
  });

  it("a different key while a job is active → 409 SYNC_JOB_ALREADY_ACTIVE with the active job id", async () => {
    const first = await (await createJob({ store_id: STORE_A })).json();
    const e = await errorOf(await createJob({ store_id: STORE_A }, "idem-2"));
    expect(e).toMatchObject({ status: 409, code: "SYNC_JOB_ALREADY_ACTIVE" });
    expect(e.body.error.active_job_id).toBe(first.job_id);
  });
});

describe("security", () => {
  it("15. forged workspace_id in the body is rejected (authorization comes from the key)", async () => {
    const e = await errorOf(await createJob({ store_id: STORE_A, workspace_id: WS_B }));
    expect(e).toMatchObject({ status: 422, code: "INVALID_REQUEST" });
    expect(e.body.error.message).toBe("Unknown field: workspace_id.");
    expect(env.repo.createJob).not.toHaveBeenCalled();
  });

  it("credentials in the body are rejected", async () => {
    expect((await createJob({ store_id: STORE_A, shopify_token: "shpat_x" })).status).toBe(422);
  });

  it("16. forged store_id (other workspace) → 404", async () => {
    expect((await errorOf(await createJob({ store_id: STORE_B }))).code).toBe("STORE_NOT_FOUND");
    expect((await errorOf(await getStatus("not-a-uuid"))).code).toBe("STORE_NOT_FOUND");
  });

  it("17. forged job_id (other workspace) → 404 for get and cancel", async () => {
    const bKey = env.addKey({ workspaceId: WS_B });
    const bJob = await (await createJob({ store_id: STORE_B }, "b", { token: bKey.token })).json();
    expect((await errorOf(await getJob(bJob.job_id))).code).toBe("JOB_NOT_FOUND");
    expect((await errorOf(await cancel(bJob.job_id))).code).toBe("JOB_NOT_FOUND");
    expect((await errorOf(await getJob("not-a-uuid"))).code).toBe("JOB_NOT_FOUND");
  });

  it("18-21. secret / tokens never appear in responses or logs", async () => {
    const texts = [
      await (await getStatus(STORE_A)).text(),
      await (await createJob({ store_id: STORE_A })).text(),
      await (await getStatus(STORE_B)).text(),
      await (await getStatus(STORE_A, { token: `${parseApiToken(key.token)!.prefix}_${"B".repeat(43)}` })).text(),
    ];
    const secret = parseApiToken(key.token)!.secret;
    for (const t of [...texts, ...logs]) {
      expect(t).not.toContain(secret);
      expect(t).not.toContain(key.token);
      expect(t).not.toContain(key.secretHash);
      expect(t).not.toMatch(/shpat_|shprt_|ya29\.|1\/\/|v1\.[A-Za-z0-9_-]+\./);
    }
    // Every request is audited by id, without secrets.
    const audit = logs.filter((l) => l.includes('"event":"n8n_api"')).map((l) => JSON.parse(l));
    expect(audit.length).toBe(4);
    expect(audit[0]).toMatchObject({ api_key_id: key.id, route: "GET /stores/:storeId/status", status: 200 });
    expect(audit[3]).toMatchObject({ api_key_id: null, status: 401, code: "INVALID_API_KEY" });
  });

  it("store status contains safe fields only", async () => {
    const body = await (await getStatus(STORE_A)).json();
    expect(Object.keys(body).sort()).toEqual(["google_drive", "ready_for_sync", "shopify", "store_id", "store_name"]);
    expect(JSON.stringify(body)).not.toMatch(/token|secret|encrypt/i);
  });
});

describe("request signing (optional HMAC) + replay protection", () => {
  function signed(path: string, method: string, body: string, opts: { ts?: number; rid?: string; signingKey?: string } = {}) {
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const rid = opts.rid ?? "req-signed-0001";
    const canonical = canonicalString({ timestamp: ts, method, pathWithQuery: new URL(`${BASE}${path}`).pathname, body, requestId: rid });
    return {
      "x-pis-timestamp": ts,
      "x-request-id": rid,
      "x-pis-signature": signRequest(opts.signingKey ?? key.signingKey, canonical),
    };
  }

  it("a valid signature is accepted; replaying the same request is rejected", async () => {
    const path = `/stores/${STORE_A}/status`;
    const h = signed(path, "GET", "");
    expect((await getStatus(STORE_A, { headers: h })).status).toBe(200);
    expect(await errorOf(await getStatus(STORE_A, { headers: h }))).toMatchObject({ status: 401, code: "REPLAYED_REQUEST" });
  });

  it("a tampered body / wrong key / stale timestamp is rejected", async () => {
    const body = JSON.stringify({ store_id: STORE_A });
    const h = signed("/sync-jobs", "POST", body, { rid: "req-signed-0002" });
    const tampered = await createJob({ store_id: STORE_A, dry_run: true }, "i", { headers: h });
    expect((await errorOf(tampered)).code).toBe("INVALID_SIGNATURE");
    const wrongKey = signed(`/stores/${STORE_A}/status`, "GET", "", { rid: "req-signed-0003", signingKey: sha256Hex("other") });
    expect((await errorOf(await getStatus(STORE_A, { headers: wrongKey }))).code).toBe("INVALID_SIGNATURE");
    const stale = signed(`/stores/${STORE_A}/status`, "GET", "", { rid: "req-signed-0004", ts: Math.floor(Date.now() / 1000) - 3600 });
    expect((await errorOf(await getStatus(STORE_A, { headers: stale }))).code).toBe("REQUEST_EXPIRED");
  });

  it("signed POST (create job) works end-to-end", async () => {
    const body = { store_id: STORE_A };
    const h = signed("/sync-jobs", "POST", JSON.stringify(body), { rid: "req-signed-0005" });
    expect((await createJob(body, "signed-idem", { headers: h })).status).toBe(201);
  });

  it("N8N_API_REQUIRE_SIGNATURE=true rejects unsigned requests", async () => {
    vi.stubEnv("N8N_API_REQUIRE_SIGNATURE", "true");
    expect((await errorOf(await getStatus(STORE_A))).code).toBe("INVALID_SIGNATURE");
  });
});

describe("API behavior", () => {
  it("22. health is public, static and leaks nothing", async () => {
    const res = health.GET(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "product-image-sync", version: "v1" });
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(env.repo.authenticate).not.toHaveBeenCalled();
  });

  it("23. store status", async () => {
    const body = await (await getStatus(STORE_A)).json();
    expect(body).toMatchObject({
      store_id: STORE_A,
      store_name: "BrandSure",
      shopify: { connected: true },
      google_drive: { connected: true, root_folder_selected: true, root_folder_name: "Sofa" },
      ready_for_sync: true,
    });
  });

  it("24/25. create job → get job (queued, no sync performed)", async () => {
    const created = await (await createJob({ store_id: STORE_A, dry_run: true, category: "Sofa", folder_id: "sofaFolderId001" })).json();
    expect(created).toMatchObject({ dry_run: true, options: { category: "Sofa", folder_id: "sofaFolderId001" } });
    const res = await getJob(created.job_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job_id: created.job_id, status: "queued" });
  });

  it("missing integrations → clear error codes", async () => {
    expect((await errorOf(await createJob({ store_id: STORE_A2 }))).code).toBe("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
    env.stores[1]!.drive = false;
    expect((await errorOf(await createJob({ store_id: STORE_A2 }, "x2"))).code).toBe("GOOGLE_DRIVE_NOT_CONNECTED");
    env.stores[1]!.shopify = false;
    expect((await errorOf(await createJob({ store_id: STORE_A2 }, "x3"))).code).toBe("SHOPIFY_NOT_CONNECTED");
  });

  it("26/28. list jobs with keyset pagination", async () => {
    const other = env.addKey();
    for (let i = 0; i < 5; i++) {
      const j = await (await createJob({ store_id: STORE_A }, `k${i}`, { token: other.token })).json();
      await cancel(j.job_id); // free the store for the next job
    }
    const p1 = await (await jobsRoute.GET(req("/sync-jobs?limit=2"))).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await (await jobsRoute.GET(req(`/sync-jobs?limit=2&cursor=${p1.next_cursor}`))).json();
    const p3 = await (await jobsRoute.GET(req(`/sync-jobs?limit=2&cursor=${p2.next_cursor}`))).json();
    expect(p3.next_cursor).toBeNull();
    const ids = [...p1.data, ...p2.data, ...p3.data].map((j: { job_id: string }) => j.job_id);
    expect(new Set(ids).size).toBe(5);
    const filtered = await (await jobsRoute.GET(req(`/sync-jobs?store_id=${STORE_A}&status=cancelled&limit=100`))).json();
    expect(filtered.data).toHaveLength(5);
    expect((await errorOf(await jobsRoute.GET(req("/sync-jobs?limit=500")))).status).toBe(422);
    expect((await errorOf(await jobsRoute.GET(req("/sync-jobs?status=done")))).status).toBe(422);
    expect((await errorOf(await jobsRoute.GET(req("/sync-jobs?cursor=garbage")))).status).toBe(422);
  });

  it("never lists another workspace's jobs", async () => {
    const bKey = env.addKey({ workspaceId: WS_B });
    await createJob({ store_id: STORE_B }, "b", { token: bKey.token });
    const list = await (await jobsRoute.GET(req("/sync-jobs"))).json();
    expect(list.data).toEqual([]);
  });

  it("27. cancel job: queued → cancelled; again → no error, changed=false", async () => {
    const j = await (await createJob({ store_id: STORE_A })).json();
    const c1 = await cancel(j.job_id);
    expect(c1.status).toBe(200);
    expect(await c1.json()).toMatchObject({ status: "cancelled", changed: true });
    const c2 = await cancel(j.job_id);
    expect(c2.status).toBe(200);
    expect(await c2.json()).toMatchObject({ status: "cancelled", changed: false });
  });

  it("29. invalid JSON → 400; wrong content type → 415; too large → 413", async () => {
    expect((await errorOf(await createJob("{not json"))).code).toBe("INVALID_JSON");
    expect((await errorOf(await createJob("store_id=x", "i", { headers: { "content-type": "text/plain" } }))).code).toBe(
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect((await errorOf(await createJob(JSON.stringify({ store_id: STORE_A, category: "x".repeat(20_000) })))).code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("30. rate limiting → 429 with Retry-After", async () => {
    env.limits.override = 2;
    expect((await getStatus(STORE_A)).status).toBe(200);
    expect((await getStatus(STORE_A)).status).toBe(200);
    const res = await getStatus(STORE_A);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });

  it("rate limits are scoped per key and per workspace", async () => {
    await getStatus(STORE_A);
    expect([...env.buckets.keys()]).toEqual(expect.arrayContaining([`key:${key.id}:read`, `ws:aaaaaaaa-0000-4000-8000-00000000000a`]));
    await createJob({ store_id: STORE_A });
    expect([...env.buckets.keys()]).toContain(`key:${key.id}:write`);
  });

  it("X-Request-ID: echoed when valid, generated otherwise", async () => {
    expect((await getStatus(STORE_A, { headers: { "x-request-id": "n8n-exec-12345" } })).headers.get("x-request-id")).toBe("n8n-exec-12345");
    expect((await getStatus(STORE_A, { headers: { "x-request-id": "bad id!" } })).headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("unexpected failures → 500 without internals", async () => {
    vi.mocked(env.repo.storeStatus).mockRejectedValueOnce(new Error('relation "x" does not exist at /db/secret'));
    const res = await getStatus(STORE_A);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("relation");
  });
});
