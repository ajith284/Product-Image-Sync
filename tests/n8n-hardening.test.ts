import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientIp, RATE_LIMITS } from "@/lib/n8n/handler";
import {
  canonicalString,
  parseApiToken,
  sha256Hex,
  signRequest,
} from "@/lib/n8n/keys";
import { fakeN8n, STORE_A, STORE_A2, STORE_B, WS_B } from "./helpers/fake-n8n";

/**
 * Prompt 14D — adversarial tests for /api/n8n/v1 (complements tests/n8n-api.test.ts and
 * tests/n8n-run-route.test.ts): auth edge cases, X-Forwarded-For throttling, signature /
 * replay edge cases, POST /run, and request-body limits. Fakes only — no network, no DB.
 */

const mocks = vi.hoisted(() => ({ repo: null as unknown, launch: vi.fn() }));
vi.mock("@/lib/n8n/runtime", () => ({ getN8nRepository: () => mocks.repo }));
vi.mock("@/lib/sync/launch", () => ({ launchSyncWorker: mocks.launch }));

const statusRoute =
  await import("@/app/api/n8n/v1/stores/[storeId]/status/route");
const jobsRoute = await import("@/app/api/n8n/v1/sync-jobs/route");
const jobRoute = await import("@/app/api/n8n/v1/sync-jobs/[jobId]/route");
const cancelRoute =
  await import("@/app/api/n8n/v1/sync-jobs/[jobId]/cancel/route");
const runRoute = await import("@/app/api/n8n/v1/sync-jobs/[jobId]/run/route");

const ORIGIN = "https://reach-rental-heat.ngrok-free.dev";
const BASE = `${ORIGIN}/api/n8n/v1`;
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Init = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  token?: string | null;
  auth?: string;
};
function req(path: string, o: Init = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.auth !== undefined) headers.authorization = o.auth;
  else if (o.token !== null)
    headers.authorization = `Bearer ${o.token ?? key.token}`;
  if (typeof o.body === "string" && o.body)
    headers["content-type"] ??= "application/json";
  return new NextRequest(`${BASE}${path}`, {
    method: o.method ?? (o.body ? "POST" : "GET"),
    headers,
    body: o.body ?? undefined,
    duplex: "half",
  } as NonNullable<ConstructorParameters<typeof NextRequest>[1]>);
}
const p = <T extends Record<string, string>>(x: T) => ({
  params: Promise.resolve(x),
});
const status = (storeId: string, o: Init = {}) =>
  statusRoute.GET(req(`/stores/${storeId}/status`, o), p({ storeId }));
const create = (body: unknown, idem: string, o: Init = {}) =>
  jobsRoute.POST(
    req("/sync-jobs", {
      ...o,
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "idempotency-key": idem, ...(o.headers ?? {}) },
    }),
  );
const getJob = (jobId: string, o: Init = {}) =>
  jobRoute.GET(req(`/sync-jobs/${jobId}`, o), p({ jobId }));
const cancel = (jobId: string, o: Init = {}) =>
  cancelRoute.POST(
    req(`/sync-jobs/${jobId}/cancel`, { method: "POST", ...o }),
    p({ jobId }),
  );
const run = (jobId: string, o: Init = {}) =>
  runRoute.POST(
    req(`/sync-jobs/${jobId}/run`, { method: "POST", ...o }),
    p({ jobId }),
  );
async function err(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return {
    status: res.status,
    code: body.error?.code as string | undefined,
    body,
    text,
  };
}
async function newJob(storeId = STORE_A) {
  const res = await create(
    { store_id: storeId, dry_run: true },
    `idem-${Math.random()}`,
  );
  return ((await res.json()) as { job_id: string }).job_id;
}

// ---------------------------------------------------------------------------
describe("authentication edge cases", () => {
  it.each([
    ["no Authorization header", { token: null }],
    [
      "Basic scheme",
      { auth: `Basic ${Buffer.from("user:pass").toString("base64")}` },
    ],
    ["Bearer without token", { auth: "Bearer" }],
    ["Bearer with blank token", { auth: "Bearer    " }],
    ["token with trailing junk", { auth: "Bearer TOKEN extra" }],
    ["two credentials", { auth: "Bearer TOKEN, Bearer TOKEN" }],
    [
      "random well-formed key",
      { token: "pis_live_ABCDEFGHJKMN_" + "x".repeat(43) },
    ],
    ["right prefix, wrong secret", { token: "PREFIX_" + "y".repeat(43) }],
    ["10 KB garbage token", { token: "z".repeat(10_000) }],
    ["SQL-ish token", { token: "pis_live_' OR 1=1 --" }],
  ])(
    "%s → 401 INVALID_API_KEY with the standard error body",
    async (_label, o) => {
      const init = { ...o } as Init;
      if (init.auth) init.auth = init.auth.replace(/TOKEN/g, key.token);
      if (init.token?.startsWith("PREFIX_"))
        init.token = init.token.replace("PREFIX", key.prefix);
      const r = await err(await status(STORE_A, init));
      expect(r.status).toBe(401);
      expect(r.code).toBe("INVALID_API_KEY");
      expect(Object.keys(r.body.error).sort()).toEqual([
        "code",
        "message",
        "request_id",
      ]);
      expect(r.text).not.toContain(key.token);
      expect(logs.join("\n")).not.toContain(parseApiToken(key.token)!.secret);
    },
  );

  it("scheme is case-insensitive (bearer / BEARER) for a valid key", async () => {
    expect(
      (await status(STORE_A, { auth: `bearer ${key.token}` })).status,
    ).toBe(200);
    expect(
      (await status(STORE_A, { auth: `BEARER ${key.token}` })).status,
    ).toBe(200);
  });

  it("revoked key → 401 on every route; nothing is read or changed", async () => {
    const jobId = await newJob();
    env.keys.find((k) => k.id === key.id)!.revoked = true;
    for (const res of [
      await status(STORE_A),
      await getJob(jobId),
      await cancel(jobId),
      await run(jobId),
      await create({ store_id: STORE_A }, "rev-1"),
    ]) {
      expect((await err(res)).code).toBe("INVALID_API_KEY");
    }
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(env.jobs.find((j) => j.job_id === jobId)!.status).toBe("queued");
  });

  it("wrong scope → 403 on every write route, before any data is touched", async () => {
    const jobId = await newJob();
    const readOnly = env.addKey({ scopes: ["n8n:read"] });
    const o = { token: readOnly.token };
    vi.mocked(env.repo.createJob).mockClear();
    for (const res of [
      await create({ store_id: STORE_A }, "scope-1", o),
      await run(jobId, o),
      await cancel(jobId, o),
      await getJob(jobId, o),
    ]) {
      expect((await err(res)).code).toBe("INSUFFICIENT_SCOPE");
    }
    expect(env.repo.createJob).not.toHaveBeenCalled();
    expect(env.repo.startJob).not.toHaveBeenCalled();
    expect(env.repo.cancelJob).not.toHaveBeenCalled();
  });

  it("other workspace's key → 404 for the store and every job route (same as unknown)", async () => {
    const jobId = await newJob();
    const other = env.addKey({ workspaceId: WS_B });
    const o = { token: other.token };
    expect((await err(await status(STORE_A, o))).code).toBe("STORE_NOT_FOUND");
    for (const res of [
      await getJob(jobId, o),
      await cancel(jobId, o),
      await run(jobId, o),
    ])
      expect((await err(res)).code).toBe("JOB_NOT_FOUND");
    expect(
      (await err(await create({ store_id: STORE_A }, "x-ws", o))).code,
    ).toBe("STORE_NOT_FOUND");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("store-restricted key → its own store only; another store's status, create and jobs → 404", async () => {
    const jobId = await newJob(STORE_A);
    const restricted = env.addKey({ storeId: STORE_A2 });
    const o = { token: restricted.token };
    expect((await err(await status(STORE_A, o))).code).toBe("STORE_NOT_FOUND");
    expect(
      (await err(await create({ store_id: STORE_A }, "restricted-1", o))).code,
    ).toBe("STORE_NOT_FOUND");
    for (const res of [
      await getJob(jobId, o),
      await run(jobId, o),
      await cancel(jobId, o),
    ])
      expect((await err(res)).code).toBe("JOB_NOT_FOUND");
    expect((await status(STORE_A2, o)).status).toBe(200);
  });

  it.each([
    ["not-a-uuid"],
    ["..%2F..%2Fadmin"],
    ["00000000-0000-0000-0000-000000000000x"],
    ["' or 1=1 --"],
    ["%00"],
  ])(
    "malformed id %j → same 404 as a foreign id, nothing queried",
    async (id) => {
      expect((await err(await status(id))).code).toBe("STORE_NOT_FOUND");
      for (const res of [await getJob(id), await cancel(id), await run(id)])
        expect((await err(res)).code).toBe("JOB_NOT_FOUND");
      expect(env.repo.startJob).not.toHaveBeenCalled();
    },
  );

  it("unexpected repository failures → sanitized 500 (no DB text, no secret)", async () => {
    env.repo.storeStatus = vi.fn(async () => {
      throw new Error(
        "connection to postgres://service_role:sb_secret_LEAK@db failed",
      );
    });
    const r = await err(await status(STORE_A));
    expect(r).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(r.text + logs.join("\n")).not.toMatch(
      /sb_secret_|service_role|postgres:\/\//,
    );
  });
});

// ---------------------------------------------------------------------------
describe("failed-auth throttling vs. X-Forwarded-For", () => {
  const LIMIT = RATE_LIMITS.authFailuresPerIp;
  const REAL_IP = "203.0.113.7";
  /** What ngrok forwards: the client's own (spoofed) X-Forwarded-For with the real IP APPENDED. */
  const viaNgrok = (spoofed: string) => ({
    "x-forwarded-for": `${spoofed}, ${REAL_IP}`,
  });

  it("rotating a spoofed first X-Forwarded-For entry does NOT reset the throttle (bucket = real client IP)", async () => {
    const results: number[] = [];
    for (let i = 0; i < LIMIT + 5; i++) {
      results.push(
        (
          await status(STORE_A, {
            token: "pis_live_ABCDEFGHJKMN_" + "q".repeat(43),
            headers: viaNgrok(`10.0.0.${i}`),
          })
        ).status,
      );
    }
    expect(results.slice(0, LIMIT).every((s) => s === 401)).toBe(true);
    expect(results.slice(LIMIT)).toEqual(Array(5).fill(429));
    expect([...env.buckets.keys()].some((b) => b.includes("10.0.0."))).toBe(
      false,
    );
  });

  it("the 429 carries Retry-After and the standard error body", async () => {
    let last: Response | null = null;
    for (let i = 0; i <= LIMIT; i++)
      last = await status(STORE_A, {
        token: "bad",
        headers: viaNgrok(`198.51.100.${i}`),
      });
    const r = await err(last!);
    expect(r).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(last!.headers.get("retry-after")).toBeTruthy();
  });

  it("different real clients keep separate buckets", async () => {
    for (let i = 0; i < LIMIT; i++)
      await status(STORE_A, {
        token: "bad",
        headers: { "x-forwarded-for": "203.0.113.50" },
      });
    expect(
      (
        await status(STORE_A, {
          token: "bad",
          headers: { "x-forwarded-for": "203.0.113.51" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await status(STORE_A, {
          token: "bad",
          headers: { "x-forwarded-for": "203.0.113.50" },
        })
      ).status,
    ).toBe(429);
  });

  it("a valid key is never throttled by the failed-auth bucket", async () => {
    for (let i = 0; i <= LIMIT; i++)
      await status(STORE_A, {
        token: "bad",
        headers: { "x-forwarded-for": REAL_IP },
      });
    expect(
      (await status(STORE_A, { headers: { "x-forwarded-for": REAL_IP } }))
        .status,
    ).toBe(200);
  });

  it("without any proxy header, a spoofable X-Real-IP is ignored (one shared bucket)", async () => {
    const results: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++)
      results.push(
        (
          await status(STORE_A, {
            token: "bad",
            headers: { "x-real-ip": `192.0.2.${i}` },
          })
        ).status,
      );
    expect(results.slice(LIMIT)).toEqual([429, 429]);
  });

  it("N8N_TRUSTED_PROXY_HOPS=2 (e.g. CDN → ngrok → app) uses the second entry from the right", async () => {
    vi.stubEnv("N8N_TRUSTED_PROXY_HOPS", "2");
    const results: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) {
      results.push(
        (
          await status(STORE_A, {
            token: "bad",
            headers: {
              "x-forwarded-for": `9.9.9.${i}, ${REAL_IP}, 172.16.0.1`,
            },
          })
        ).status,
      );
    }
    expect(results.at(-1)).toBe(429);
    expect([...env.buckets.keys()].some((b) => b.includes(REAL_IP))).toBe(true);
  });

  it.each([
    ["single value (Vercel)", "203.0.113.9", "1", "203.0.113.9"],
    ["spoofed + appended (ngrok)", "6.6.6.6, 203.0.113.9", "1", "203.0.113.9"],
    ["IPv4 with port", "6.6.6.6, 203.0.113.9:51234", "1", "203.0.113.9"],
    ["IPv6", "6.6.6.6, 2001:DB8::1", "1", "2001:db8::1"],
    [
      "bracketed IPv6 with port",
      "6.6.6.6, [2001:db8::2]:443",
      "1",
      "2001:db8::2",
    ],
    ["garbage last entry", "203.0.113.9, not-an-ip", "1", "invalid"],
    ["empty header", "", "1", "direct"],
    ["hops larger than the list", "203.0.113.9", "5", "203.0.113.9"],
    ["hops env garbage → 1", "6.6.6.6, 203.0.113.9", "abc", "203.0.113.9"],
    ["hops env 0 → 1", "6.6.6.6, 203.0.113.9", "0", "203.0.113.9"],
  ])("clientIp: %s", (_label, xff, hops, expected) => {
    vi.stubEnv("N8N_TRUSTED_PROXY_HOPS", hops);
    expect(clientIp(new Headers(xff ? { "x-forwarded-for": xff } : {}))).toBe(
      expected,
    );
  });

  it("garbage / oversized forwarded values never become unbounded bucket keys", async () => {
    await status(STORE_A, {
      token: "bad",
      headers: { "x-forwarded-for": `1.1.1.1, ${"<script>".repeat(200)}` },
    });
    for (const b of env.buckets.keys()) {
      expect(b.length).toBeLessThanOrEqual(80);
      expect(b).not.toContain("<script>");
    }
  });
});

// ---------------------------------------------------------------------------
describe("request signing / replay edge cases", () => {
  const now = () => Math.floor(Date.now() / 1000);
  function sign(
    path: string,
    method: string,
    body: string,
    o: { ts?: string; rid?: string; signingKey?: string } = {},
  ) {
    const ts = o.ts ?? String(now());
    const rid = o.rid ?? `req-${Math.random().toString(36).slice(2, 12)}`;
    const u = new URL(`${BASE}${path}`);
    const canonical = canonicalString({
      timestamp: ts,
      method,
      pathWithQuery: u.pathname + u.search,
      body,
      requestId: rid,
    });
    return {
      "x-pis-timestamp": ts,
      "x-request-id": rid,
      "x-pis-signature": signRequest(o.signingKey ?? key.signingKey, canonical),
    };
  }
  const listJobs = (query: string, headers: Record<string, string>) =>
    jobsRoute.GET(req(`/sync-jobs${query}`, { headers }));

  it("valid signature on GET, POST create, cancel and /run", async () => {
    vi.stubEnv("N8N_API_REQUIRE_SIGNATURE", "true");
    expect(
      (
        await status(STORE_A, {
          headers: sign(`/stores/${STORE_A}/status`, "GET", ""),
        })
      ).status,
    ).toBe(200);
    const body = JSON.stringify({ store_id: STORE_A, dry_run: true });
    const created = await jobsRoute.POST(
      req("/sync-jobs", {
        body,
        headers: {
          "idempotency-key": "signed-1",
          ...sign("/sync-jobs", "POST", body),
        },
      }),
    );
    expect(created.status).toBe(201);
    const jobId = ((await created.json()) as { job_id: string }).job_id;
    expect(
      (
        await run(jobId, {
          headers: sign(`/sync-jobs/${jobId}/run`, "POST", ""),
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await cancel(jobId, {
          headers: sign(`/sync-jobs/${jobId}/cancel`, "POST", ""),
        })
      ).status,
    ).toBe(200);
  });

  it("missing signature when required → 401 on every route (health stays public)", async () => {
    vi.stubEnv("N8N_API_REQUIRE_SIGNATURE", "true");
    const jobId = env.jobs[0]?.job_id ?? "11111111-1111-4111-8111-111111111111";
    for (const res of [
      await status(STORE_A),
      await create({ store_id: STORE_A }, "unsigned-1"),
      await run(jobId),
      await cancel(jobId),
      await getJob(jobId),
    ]) {
      expect((await err(res)).code).toBe("INVALID_SIGNATURE");
    }
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it.each([
    ["stale (301 s old)", () => String(now() - 301)],
    ["future beyond skew (+301 s)", () => String(now() + 301)],
    ["milliseconds instead of seconds", () => String(Date.now())],
    ["not a number", () => "yesterday"],
    ["decimal", () => `${now()}.5`],
    ["empty", () => ""],
  ])("timestamp %s → 401 REQUEST_EXPIRED", async (_label, ts) => {
    const r = await err(
      await status(STORE_A, {
        headers: sign(`/stores/${STORE_A}/status`, "GET", "", { ts: ts() }),
      }),
    );
    expect(r).toMatchObject({ status: 401, code: "REQUEST_EXPIRED" });
  });

  it("future timestamp within the allowed skew (+200 s) is accepted", async () => {
    expect(
      (
        await status(STORE_A, {
          headers: sign(`/stores/${STORE_A}/status`, "GET", "", {
            ts: String(now() + 200),
          }),
        })
      ).status,
    ).toBe(200);
  });

  it("changed body → INVALID_SIGNATURE", async () => {
    const h = sign(
      "/sync-jobs",
      "POST",
      JSON.stringify({ store_id: STORE_A, dry_run: true }),
    );
    const r = await err(
      await create({ store_id: STORE_A, dry_run: false }, "tamper-body", {
        headers: h,
      }),
    );
    expect(r.code).toBe("INVALID_SIGNATURE");
    expect(env.jobs).toHaveLength(0);
  });

  it("changed path (signed for another store / job) → INVALID_SIGNATURE", async () => {
    const h = sign(`/stores/${STORE_A2}/status`, "GET", "");
    expect((await err(await status(STORE_A, { headers: h }))).code).toBe(
      "INVALID_SIGNATURE",
    );
    const jobId = await newJob();
    const otherJob = "22222222-2222-4222-8222-222222222222";
    expect(
      (
        await err(
          await run(jobId, {
            headers: sign(`/sync-jobs/${otherJob}/run`, "POST", ""),
          }),
        )
      ).code,
    ).toBe("INVALID_SIGNATURE");
    expect(
      (
        await err(
          await run(jobId, {
            headers: sign(`/sync-jobs/${jobId}/cancel`, "POST", ""),
          }),
        )
      ).code,
    ).toBe("INVALID_SIGNATURE");
  });

  it("changed query string → INVALID_SIGNATURE", async () => {
    const h = sign("/sync-jobs?limit=5", "GET", "");
    expect((await err(await listJobs("?limit=50", h))).code).toBe(
      "INVALID_SIGNATURE",
    );
    expect(
      (await listJobs("?limit=5", sign("/sync-jobs?limit=5", "GET", "")))
        .status,
    ).toBe(200);
  });

  it("changed method → INVALID_SIGNATURE", async () => {
    const jobId = await newJob();
    const h = sign(`/sync-jobs/${jobId}/run`, "GET", "");
    expect((await err(await run(jobId, { headers: h }))).code).toBe(
      "INVALID_SIGNATURE",
    );
  });

  it("exact replay → REPLAYED_REQUEST; reusing a request id with a NEW valid signature → REPLAYED_REQUEST", async () => {
    const h = sign(`/stores/${STORE_A}/status`, "GET", "", {
      rid: "req-replay-0001",
    });
    expect((await status(STORE_A, { headers: h })).status).toBe(200);
    expect((await err(await status(STORE_A, { headers: h }))).code).toBe(
      "REPLAYED_REQUEST",
    );
    const fresh = sign(`/stores/${STORE_A}/status`, "GET", "", {
      rid: "req-replay-0001",
      ts: String(now() - 1),
    });
    expect((await err(await status(STORE_A, { headers: fresh }))).code).toBe(
      "REPLAYED_REQUEST",
    );
  });

  it("nonces are per key: the same request id with another key is fine", async () => {
    const other = env.addKey();
    expect(
      (
        await status(STORE_A, {
          headers: sign(`/stores/${STORE_A}/status`, "GET", "", {
            rid: "req-shared-0001",
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await status(STORE_A, {
          token: other.token,
          headers: sign(`/stores/${STORE_A}/status`, "GET", "", {
            rid: "req-shared-0001",
            signingKey: other.signingKey,
          }),
        })
      ).status,
    ).toBe(200);
  });

  it("a blank signature header counts as unsigned: allowed only while signing is optional", async () => {
    const h = {
      ...sign(`/stores/${STORE_A}/status`, "GET", ""),
      "x-pis-signature": "   ",
    };
    expect((await status(STORE_A, { headers: h })).status).toBe(200);
    vi.stubEnv("N8N_API_REQUIRE_SIGNATURE", "true");
    expect(
      (
        await err(
          await status(STORE_A, {
            headers: { ...h, "x-request-id": "req-blank-0002" },
          }),
        )
      ).code,
    ).toBe("INVALID_SIGNATURE");
  });

  it("signed request without a client X-Request-ID → INVALID_SIGNATURE", async () => {
    const h = sign(`/stores/${STORE_A}/status`, "GET", "");
    const { "x-request-id": _rid, ...noRid } = h;
    void _rid;
    expect((await err(await status(STORE_A, { headers: noRid }))).code).toBe(
      "INVALID_SIGNATURE",
    );
  });

  it.each([
    ["v1=zz"],
    ["v2=" + "a".repeat(64)],
    ["v1=" + "a".repeat(63)],
    ["v1=" + "A".repeat(64)],
    ["v1=" + "a".repeat(64) + "00"],
  ])("malformed signature header %j → INVALID_SIGNATURE", async (sig) => {
    const h = {
      ...sign(`/stores/${STORE_A}/status`, "GET", ""),
      "x-pis-signature": sig,
    };
    expect((await err(await status(STORE_A, { headers: h }))).code).toBe(
      "INVALID_SIGNATURE",
    );
  });

  it("a signature made with the token itself (instead of SHA-256(secret)) is rejected", async () => {
    const h = sign(`/stores/${STORE_A}/status`, "GET", "", {
      signingKey: key.token,
    });
    expect((await err(await status(STORE_A, { headers: h }))).code).toBe(
      "INVALID_SIGNATURE",
    );
    expect(sha256Hex("x")).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
describe("Bearer-only (unsigned) replay safety — basis of the Prompt 14F signing decision", () => {
  it("replaying an identical unsigned write request never duplicates work", async () => {
    const body = { store_id: STORE_A, dry_run: false };
    const first = await create(body, "n8n-4242-create");
    const replay = await create(body, "n8n-4242-create");
    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(env.jobs).toHaveLength(1);
    const jobId = env.jobs[0]!.job_id;
    expect((await run(jobId)).status).toBe(202);
    expect(await (await run(jobId)).json()).toMatchObject({
      claimed: false,
      reason: "already_running",
    });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect((await cancel(jobId)).status).toBe(200);
    expect(await (await cancel(jobId)).json()).toMatchObject({
      changed: false,
    });
  });

  it("the signing key is derived from the API secret (SHA-256), so signing adds no protection against a stolen token", () => {
    expect(key.signingKey).toBe(sha256Hex(parseApiToken(key.token)!.secret));
  });
});

// ---------------------------------------------------------------------------
describe("POST /sync-jobs/{jobId}/run", () => {
  it("replayed signed /run → REPLAYED_REQUEST, worker launched once", async () => {
    const jobId = await newJob();
    const ts = String(Math.floor(Date.now() / 1000));
    const rid = "req-run-replay-01";
    const u = new URL(`${BASE}/sync-jobs/${jobId}/run`);
    const h = {
      "x-pis-timestamp": ts,
      "x-request-id": rid,
      "x-pis-signature": signRequest(
        key.signingKey,
        canonicalString({
          timestamp: ts,
          method: "POST",
          pathWithQuery: u.pathname,
          body: "",
          requestId: rid,
        }),
      ),
    };
    expect((await run(jobId, { headers: h })).status).toBe(202);
    expect((await err(await run(jobId, { headers: h }))).code).toBe(
      "REPLAYED_REQUEST",
    );
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it("unsigned repeated /run (the n8n production path) is safe: already_running, no second worker", async () => {
    const jobId = await newJob();
    expect((await run(jobId)).status).toBe(202);
    const again = await run(jobId);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      claimed: false,
      reason: "already_running",
    });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it("is rate limited per key (write bucket) → 429 with Retry-After; no launch on the limited call", async () => {
    const jobId = await newJob();
    env.buckets.clear(); // forget the create call above
    env.limits.override = 1; // every bucket allows one request per window
    const first = await run(jobId);
    expect(first.status).toBe(202);
    const limited = await run(jobId);
    expect((await err(limited)).code).toBe("RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it("stale lease → reclaimed: 202 and a new worker is launched", async () => {
    const jobId = await newJob();
    env.repo.startJob = vi.fn(async (_k: string, id: string) => ({
      job: {
        job_id: id,
        store_id: STORE_A,
        status: "running",
        created_at: "2026-10-02T00:00:00Z",
      },
      claimed: true,
      reason: "reclaimed" as const,
    }));
    const res = await run(jobId);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      claimed: true,
      reason: "reclaimed",
    });
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ jobId }),
    );
  });

  it("finished job → 200 finished, no worker", async () => {
    const jobId = await newJob();
    env.jobs.find((j) => j.job_id === jobId)!.status = "cancelled";
    const res = await run(jobId);
    expect(await res.json()).toMatchObject({
      claimed: false,
      reason: "finished",
    });
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("job of another store for a store-restricted key / unknown job → 404, no worker", async () => {
    const jobB = await newJob(STORE_A);
    const restricted = env.addKey({ storeId: STORE_A2 });
    expect((await err(await run(jobB, { token: restricted.token }))).code).toBe(
      "JOB_NOT_FOUND",
    );
    expect(
      (await err(await run("33333333-3333-4333-8333-333333333333"))).code,
    ).toBe("JOB_NOT_FOUND");
    const keyB = env.addKey({ workspaceId: WS_B });
    expect((await err(await run(jobB, { token: keyB.token }))).code).toBe(
      "JOB_NOT_FOUND",
    );
    void STORE_B;
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("repository failure during claim → sanitized 500, no worker, no secret", async () => {
    const jobId = await newJob();
    env.repo.startJob = vi.fn(async () => {
      throw new Error("deadlock detected; key=sb_secret_LEAK");
    });
    const r = await err(await run(jobId));
    expect(r).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(r.text + logs.join("\n")).not.toContain("sb_secret_");
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("the response never contains the token, the signing key or a worker internal", async () => {
    const jobId = await newJob();
    const text = await (await run(jobId)).text();
    for (const s of [key.token, key.signingKey, "worker_id", "heartbeat"])
      expect(text).not.toContain(s);
  });
});

// ---------------------------------------------------------------------------
describe("request-body limits and input safety", () => {
  const MAX = 16 * 1024;
  function lazyStream(total: number, chunk = 4096) {
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (produced >= total) return c.close();
          const n = Math.min(chunk, total - produced);
          produced += n;
          c.enqueue(new Uint8Array(n).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, pulled: () => produced, cancelled: () => cancelled };
  }
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    jobsRoute.POST(
      req("/sync-jobs", {
        body,
        headers: {
          "content-type": "application/json",
          "idempotency-key": "size-1",
          ...headers,
        },
      }),
    );

  it("Content-Length above the limit → 413 before reading the body or authenticating", async () => {
    const lazy = lazyStream(10 * MAX);
    const r = await err(
      await post(lazy.stream, { "content-length": String(MAX + 1) }),
    );
    expect(r).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(lazy.pulled()).toBe(0);
    expect(env.repo.authenticate).not.toHaveBeenCalled();
  });

  it("actual body above the limit WITHOUT Content-Length → 413, reading stops at the limit", async () => {
    const lazy = lazyStream(50 * 1024 * 1024);
    const r = await err(await post(lazy.stream));
    expect(r).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(lazy.pulled()).toBeLessThanOrEqual(MAX + 4096);
    expect(lazy.cancelled()).toBe(true);
    expect(env.repo.authenticate).not.toHaveBeenCalled();
  });

  it("a lying Content-Length (declares 10 bytes, sends 1 MiB) → 413", async () => {
    const lazy = lazyStream(1024 * 1024);
    const r = await err(await post(lazy.stream, { "content-length": "10" }));
    expect(r.code).toBe("PAYLOAD_TOO_LARGE");
    expect(lazy.pulled()).toBeLessThanOrEqual(MAX + 4096);
  });

  it("a body exactly at the limit is read (then judged on content)", async () => {
    const body = JSON.stringify({
      store_id: STORE_A,
      dry_run: true,
      category: "x",
    }).padEnd(MAX, " ");
    expect(Buffer.byteLength(body)).toBe(MAX);
    expect((await post(body)).status).toBe(201);
  });

  it.each([["abc"], ["-5"], ["1e6"]])(
    "malformed Content-Length %j → 400/422 without reading",
    async (cl) => {
      const lazy = lazyStream(100);
      const r = await err(await post(lazy.stream, { "content-length": cl }));
      expect([400, 422]).toContain(r.status);
      expect(lazy.pulled()).toBe(0);
    },
  );

  it("wrong content type → 415; invalid JSON → 400; unknown fields → 422 — all sanitized", async () => {
    const wrongType = await err(
      await jobsRoute.POST(
        req("/sync-jobs", {
          body: "store_id=x",
          headers: { "content-type": "text/plain", "idempotency-key": "ct-1" },
        }),
      ),
    );
    expect(wrongType).toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
    const badJson = await err(await post('{"store_id": '));
    expect(badJson).toMatchObject({ status: 400, code: "INVALID_JSON" });
    const unknown = await err(
      await post(
        JSON.stringify({
          store_id: STORE_A,
          workspace_id: WS_B,
          shopify_token: "shpat_LEAK",
        }),
      ),
    );
    expect(unknown).toMatchObject({ status: 422, code: "INVALID_REQUEST" });
    for (const r of [wrongType, badJson, unknown]) {
      expect(r.text).not.toContain("shpat_LEAK");
      expect(r.text).not.toMatch(/SyntaxError|at JSON|zod/i);
    }
    expect(env.jobs).toHaveLength(0);
  });

  it("an upload that breaks mid-stream → 400, nothing created", async () => {
    let n = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ < 1) c.enqueue(new TextEncoder().encode('{"store_id":'));
        else c.error(new Error("client went away"));
      },
    });
    const r = await err(await post(broken));
    expect(r.status).toBe(400);
    expect(env.jobs).toHaveLength(0);
  });
});
