import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeN8n, STORE_A, STORE_A2, WS_A, WS_B } from "./helpers/fake-n8n";

const mocks = vi.hoisted(() => ({ repo: null as unknown, launch: vi.fn() }));
vi.mock("@/lib/n8n/runtime", () => ({ getN8nRepository: () => mocks.repo }));
vi.mock("@/lib/sync/launch", () => ({ launchSyncWorker: mocks.launch }));

const jobsRoute = await import("@/app/api/n8n/v1/sync-jobs/route");
const runRoute = await import("@/app/api/n8n/v1/sync-jobs/[jobId]/run/route");

const BASE = "https://reach-rental-heat.ngrok-free.dev/api/n8n/v1";
let env: ReturnType<typeof fakeN8n>;
let key: ReturnType<ReturnType<typeof fakeN8n>["addKey"]>;
let logs: string[];

beforeEach(() => {
  env = fakeN8n();
  mocks.repo = env.repo;
  mocks.launch.mockReset();
  key = env.addKey();
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

const req = (
  path: string,
  token: string | null,
  body?: string,
  headers: Record<string, string> = {},
) =>
  new NextRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body,
  });
const params = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const create = async (dryRun = true, storeId = STORE_A) => {
  const res = await jobsRoute.POST(
    req(
      "/sync-jobs",
      key.token,
      JSON.stringify({
        store_id: storeId,
        trigger_source: "n8n",
        dry_run: dryRun,
      }),
      { "idempotency-key": `k-${Math.random()}` },
    ),
  );
  return (await res.json()) as { job_id: string };
};
const runJob = (
  jobId: string,
  token: string | null = key.token,
  body?: string,
) => runRoute.POST(req(`/sync-jobs/${jobId}/run`, token, body), params(jobId));

describe("POST /sync-jobs/:jobId/run", () => {
  it("claims a queued job (202) and starts exactly one worker with the key's workspace", async () => {
    const { job_id } = await create();
    const res = await runJob(job_id);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      job_id,
      status: "running",
      claimed: true,
      reason: "claimed",
    });
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.launch.mock.calls[0]![0]).toMatchObject({
      jobId: job_id,
      workspaceId: WS_A,
    });
    expect(mocks.launch.mock.calls[0]![0].workerId).toMatch(
      /^n8n-[0-9a-f-]{36}$/,
    );
  });

  it("a second run while the worker holds the lease → 200 claimed:false already_running, no second worker", async () => {
    const { job_id } = await create();
    await runJob(job_id);
    const res = await runJob(job_id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      claimed: false,
      reason: "already_running",
    });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it("a finished job is never restarted", async () => {
    const { job_id } = await create();
    env.jobs.find((j) => j.job_id === job_id)!.status = "completed";
    const res = await runJob(job_id);
    expect(await res.json()).toMatchObject({
      claimed: false,
      reason: "finished",
    });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("requires the API key (401) and the n8n:sync scope (403)", async () => {
    const { job_id } = await create();
    expect((await runJob(job_id, null)).status).toBe(401);
    expect(
      (await runJob(job_id, "pis_live_notreal_000000000000000000000000"))
        .status,
    ).toBe(401);
    const readOnly = env.addKey({ scopes: ["n8n:read", "n8n:jobs"] });
    expect((await runJob(job_id, readOnly.token)).status).toBe(403);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("another workspace's key or a store-restricted key for another store → 404, same as unknown", async () => {
    const { job_id } = await create();
    const other = env.addKey({ workspaceId: WS_B });
    const restricted = env.addKey({ storeId: STORE_A2 });
    for (const token of [other.token, restricted.token]) {
      const res = await runJob(job_id, token);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("JOB_NOT_FOUND");
    }
    expect((await runJob("not-a-uuid")).status).toBe(404);
    expect((await runJob("00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("ignores any body (tokens/store IDs are never accepted) and rejects malformed JSON", async () => {
    const { job_id } = await create();
    const res = await runJob(
      job_id,
      key.token,
      JSON.stringify({
        store_id: STORE_A2,
        shopify_token: "shpat_SECRET",
        google_token: "ya29.SECRET",
      }),
    );
    expect(res.status).toBe(202);
    expect(mocks.launch.mock.calls[0]![0]).toEqual({
      jobId: job_id,
      workspaceId: WS_A,
      workerId: expect.any(String),
    });
    expect((await runJob(job_id, key.token, "{bad")).status).toBe(400);
    const text =
      JSON.stringify(
        await res
          .clone()
          .json()
          .catch(() => ({})),
      ) + logs.join("\n");
    for (const m of ["shpat_SECRET", "ya29.SECRET", key.token])
      expect(text).not.toContain(m);
  });
});
