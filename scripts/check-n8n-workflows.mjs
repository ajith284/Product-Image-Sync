// Validates and simulates the generated n8n workflows (Prompt 13).
//   node scripts/check-n8n-workflows.mjs
// 1. Structure: node/connection counts, unique IDs and names, no dangling or unreachable
//    nodes, credential references by name only, inactive, no secrets.
// 2. Expressions: every "={{ … }}" and every Code node is parsed as JavaScript.
// 3. Simulation: a small executor runs the real expressions / Code nodes against a mock of
//    the Product Image Sync API for the main paths (success, retries, errors, polling, timeout).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE = "7bb362f0-ce91-4b0b-a81b-373d49f2b242";
const JOB = "11111111-2222-4333-8444-555555555555";
/** A job left active by an earlier run (its worker may be dead) — stale-job recovery scenarios. */
const ACTIVE = "99999999-0000-4000-8000-000000000000";
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};
const pass = (msg) => console.log(`  PASS ${msg}`);

// ---------------------------------------------------------------------------
// 1 + 2. Static validation
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  /pis_live_/i,
  /Bearer\s/i,
  /shpat_/i,
  /shpca_/i,
  /ya29\./,
  /1\/\/0/,
  /eyJ[A-Za-z0-9_-]{10,}/,
  /service_role/i,
  /sb_secret/i,
  /GOCSPX/i,
  /"apiKey"/i,
  /"password"/i,
];

function expressions(value, where, out) {
  if (typeof value === "string") {
    if (value.startsWith("=")) {
      const segs = [...value.slice(1).matchAll(/\{\{([\s\S]*?)\}\}/g)].map(
        (m) => m[1],
      );
      for (const s of segs) out.push({ where, code: s });
    }
  } else if (Array.isArray(value))
    value.forEach((v, i) => expressions(v, `${where}[${i}]`, out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value))
      expressions(v, `${where}.${k}`, out);
}

function validate(file, expect) {
  const raw = fs.readFileSync(file, "utf8");
  const wf = JSON.parse(raw);
  console.log(`\n== ${path.basename(file)} — "${wf.name}"`);
  const names = new Set(wf.nodes.map((n) => n.name));
  const ids = new Set(wf.nodes.map((n) => n.id));
  const edges = Object.entries(wf.connections).flatMap(([src, c]) =>
    (c.main ?? []).flatMap((outs, i) =>
      (outs ?? []).map((t) => ({ src, out: i, dst: t.node })),
    ),
  );
  console.log(`  nodes=${wf.nodes.length} connections=${edges.length}`);
  if (wf.name === expect.name) pass("workflow name");
  else fail(`name ${wf.name}`);
  if (wf.active === false) pass("inactive on import");
  else fail("active");
  if (ids.size === wf.nodes.length) pass("unique node IDs");
  else fail("duplicate node IDs");
  if (names.size === wf.nodes.length) pass("unique node names");
  else fail("duplicate node names");
  if (!("id" in wf))
    pass("no workflow ID (imports as a NEW workflow, never overwrites)");
  else fail("workflow id present");
  const dangling = edges.filter((e) => !names.has(e.src) || !names.has(e.dst));
  if (dangling.length === 0) pass("no dangling connections");
  else fail(`dangling: ${JSON.stringify(dangling)}`);
  if (
    wf.nodes.every(
      (n) =>
        Array.isArray(n.position) &&
        n.position.length === 2 &&
        n.type &&
        n.typeVersion,
    )
  )
    pass("every node has type, version, position");
  else fail("node missing type/version/position");

  // reachability from triggers
  const triggers = wf.nodes
    .filter(
      (n) =>
        /Trigger$/i.test(n.type.split(".").pop()) ||
        n.type.endsWith("manualTrigger"),
    )
    .map((n) => n.name);
  const seen = new Set(triggers);
  const stack = [...triggers];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of edges.filter((x) => x.src === cur))
      if (!seen.has(e.dst)) {
        seen.add(e.dst);
        stack.push(e.dst);
      }
  }
  const unreachable = wf.nodes
    .filter((n) => !seen.has(n.name) && n.type !== "n8n-nodes-base.stickyNote")
    .map((n) => n.name);
  if (unreachable.length === 0) pass("every node reachable from a trigger");
  else fail(`unreachable: ${unreachable}`);
  if (
    JSON.stringify(triggers.sort()) === JSON.stringify(expect.triggers.sort())
  )
    pass(`triggers: ${triggers.join(", ")}`);
  else fail(`triggers ${triggers}`);

  // credentials
  const http = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  const authed = http.filter((n) => n.parameters.authentication);
  const credOk = authed.every(
    (n) =>
      JSON.stringify(n.credentials) ===
        JSON.stringify({
          httpHeaderAuth: { name: "Product Image Sync API" },
        }) && n.parameters.genericAuthType === "httpHeaderAuth",
  );
  if (credOk)
    pass(
      `${authed.length} authenticated HTTP nodes reference "Product Image Sync API" (httpHeaderAuth) by name, no credential ID`,
    );
  else fail("credential refs");
  const unauthed = http
    .filter((n) => !n.parameters.authentication)
    .map((n) => n.name);
  if (JSON.stringify(unauthed) === JSON.stringify(["Health"]))
    pass("only Health is unauthenticated");
  else fail(`unauthenticated: ${unauthed}`);
  if (
    http.every((n) =>
      n.parameters.headerParameters.parameters.every(
        (h) => !/^authorization$/i.test(h.name),
      ),
    )
  )
    pass("no Authorization header written in nodes");
  else fail("authorization header in node");
  if (
    http.every((n) =>
      n.parameters.headerParameters.parameters.every(
        (h) => h.name !== "ngrok-skip-browser-warning",
      ),
    )
  )
    pass("no ngrok-only headers in local workflows");
  else fail("ngrok-only header present");
  const hits = SECRET_PATTERNS.filter((p) => p.test(raw));
  if (hits.length === 0) pass("no secrets / tokens / Bearer in the file");
  else fail(`secret patterns: ${hits}`);
  if (raw.includes("http://localhost:3000/api/n8n/v1"))
    pass("local Product Image Sync API baseUrl configured");
  else fail("local Product Image Sync API baseUrl missing");

  // expressions + code
  const exprs = [];
  for (const n of wf.nodes) expressions(n.parameters, n.name, exprs);
  let bad = 0;
  for (const e of exprs) {
    try {
      new Function(
        "$",
        "$json",
        "$execution",
        "$runIndex",
        "$input",
        "$now",
        `return (${e.code});`,
      );
    } catch (err) {
      bad++;
      fail(`expression ${e.where}: ${err.message}`);
    }
  }
  for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.code")) {
    try {
      new Function("$input", "$", "$runIndex", n.parameters.jsCode);
    } catch (err) {
      bad++;
      fail(`code ${n.name}: ${err.message}`);
    }
  }
  if (!bad)
    pass(
      `${exprs.length} expressions and ${wf.nodes.filter((x) => x.type === "n8n-nodes-base.code").length} Code nodes parse`,
    );
  return { wf, edges };
}

// ---------------------------------------------------------------------------
// 3. Simulation
// ---------------------------------------------------------------------------
function mockApi(scenario, dryRun) {
  const calls = [];
  const counts = {};
  const recovering = scenario.startsWith("active409") && scenario !== "active409noid";
  const job = {
    job_id: recovering ? ACTIVE : JOB,
    store_id: STORE,
    status: recovering ? (scenario === "active409finished" ? "completed" : "running") : "queued",
    trigger_source: null,
    dry_run: dryRun,
    cancel_requested: false,
    progress: {
      total: 0,
      processed: 0,
      uploaded: 0,
      skipped: 0,
      review: 0,
      failed: 0,
    },
    error: null,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    result: {},
  };
  let created = false;
  const res = (statusCode, body, headers = {}) => ({
    statusCode,
    body,
    headers,
  });
  const err = (statusCode, code, extra = {}) =>
    res(statusCode, {
      error: {
        code,
        message: `msg ${code}`,
        request_id: `req-${code}`,
        ...extra,
      },
    });
  const handle = (req) => {
    const p = new URL(req.url).pathname.replace("/api/n8n/v1", "");
    const key = `${req.method} ${p.replace(JOB, ":id").replace(ACTIVE, ":active")}`;
    counts[key] = (counts[key] ?? 0) + 1;
    calls.push({ ...req, key });
    const n = counts[key];
    if (scenario === "network" && key === "GET /health" && n === 1)
      return { error: { message: "ECONNRESET" } };
    if (p === "/health")
      return scenario === "health502" && n <= 4
        ? res(502, "Bad Gateway")
        : res(200, { ok: true, service: "product-image-sync", version: "v1" });
    if (!req.auth) return err(401, "INVALID_API_KEY");
    if (scenario === "unauth401") return err(401, "INVALID_API_KEY");
    if (p === `/stores/${STORE}/status`) {
      if (scenario === "rate429" && n === 1)
        return res(
          429,
          { error: { code: "RATE_LIMITED", message: "slow", request_id: "r" } },
          { "retry-after": "7" },
        );
      if (scenario === "store404") return err(404, "STORE_NOT_FOUND");
      const ready = scenario !== "notReady";
      return res(200, {
        store_id: STORE,
        store_name: "BrandSure",
        shopify: { connected: true, status: "connected" },
        google_drive: { connected: true, root_folder_selected: ready },
        ready_for_sync: ready,
      });
    }
    if (p === "/sync-jobs" && req.method === "POST") {
      if (scenario.startsWith("active409"))
        return err(
          409,
          "SYNC_JOB_ALREADY_ACTIVE",
          scenario === "active409noid" ? {} : { active_job_id: ACTIVE },
        );
      if (scenario === "idem409") return err(409, "IDEMPOTENCY_CONFLICT");
      const b = JSON.parse(req.body);
      if (
        Object.keys(b).sort().join() !== "dry_run,store_id,trigger_source" ||
        b.store_id !== STORE ||
        b.dry_run !== dryRun
      )
        throw new Error(`bad create body ${req.body}`);
      job.trigger_source = b.trigger_source;
      const replay = created;
      created = true;
      if (scenario === "create503" && n === 1)
        return err(503, "SERVICE_UNAVAILABLE");
      return res(replay ? 200 : 201, job, {
        "idempotent-replayed": String(replay),
      });
    }
    if (recovering && p === `/sync-jobs/${ACTIVE}/run` && req.method === "POST") {
      if (scenario === "active409stale") {
        job.started_at = "2026-10-02T01:00:00Z";
        return res(202, { ...job, claimed: true, reason: "reclaimed" });
      }
      if (scenario === "active409finished")
        return res(200, { ...job, claimed: false, reason: "finished" });
      return res(200, { ...job, claimed: false, reason: "already_running" });
    }
    if (p === `/sync-jobs/${JOB}/run` && req.method === "POST") {
      if (scenario === "start500") return err(500, "INTERNAL_ERROR");
      if (scenario === "start404") return err(404, "JOB_NOT_FOUND");
      if (job.status !== "queued")
        return res(200, { ...job, claimed: false, reason: "already_running" });
      job.status = "running";
      job.started_at = "2026-10-02T02:00:01Z";
      return res(202, { ...job, claimed: true, reason: "claimed" });
    }
    if (p === `/sync-jobs/${job.job_id}` && req.method === "GET") {
      if (scenario === "active409finished") return res(200, { ...job, completed_at: "2026-10-02T01:30:00Z" });
      if (scenario === "poll503" && n === 2)
        return res(503, "unavailable", { "retry-after": "45" });
      if (scenario === "pollTimeout") return res(200, job);
      if (n >= 3) {
        const terminal =
          {
            cancelled: "cancelled",
            failed: "failed",
            partial: "completed_with_errors",
          }[scenario] ?? "completed";
        Object.assign(job, {
          status: terminal,
          completed_at: "2026-10-02T02:03:00Z",
          cancelled_at:
            terminal === "cancelled" ? "2026-10-02T02:03:00Z" : null,
          progress: {
            total: 0,
            processed: 0,
            uploaded: 0,
            skipped: 0,
            review: 0,
            failed: terminal === "completed_with_errors" ? 1 : 0,
          },
          result: dryRun
            ? {
                dry_run: true,
                plan: { would_upload: 0, skipped: 0, review: 0, failed: 0 },
                products: 0,
                warnings: [{ type: "images_in_code_folder" }],
                review_items: [],
                failed_items: [],
              }
            : { products: 0, uploaded: 0, warnings: [] },
          error:
            terminal === "failed"
              ? {
                  code: "GOOGLE_DRIVE_UNAVAILABLE",
                  message: "Drive unavailable",
                }
              : null,
        });
      }
      return res(200, job);
    }
    return err(404, "NOT_FOUND");
  };
  return { handle, calls, counts };
}

function simulate(wf, edges, scenario, { trigger = "Manual Trigger", dryRun }) {
  const api = mockApi(scenario, dryRun);
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const runs = {}; // name → list of outputs
  const $ = (name) => {
    const r = runs[name];
    return {
      first: () => {
        if (!r) throw new Error(`node ${name} has not run`);
        return r.at(-1)[0];
      },
      last: () => {
        if (!r) throw new Error(`node ${name} has not run`);
        return r.at(-1).at(-1);
      },
      all: () => r?.at(-1) ?? [],
      isExecuted: Boolean(r),
    };
  };
  const $execution = { id: "4242" };
  const ev = (v, $json, $runIndex) => {
    if (typeof v !== "string" || !v.startsWith("=")) return v;
    const s = v.slice(1);
    const f = (code) =>
      new Function(
        "$",
        "$json",
        "$execution",
        "$runIndex",
        `return (${code});`,
      )($, $json, $execution, $runIndex);
    const whole = s.match(/^\{\{([\s\S]*)\}\}$/);
    if (whole && !whole[1].includes("}}")) return f(whole[1]);
    return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, c) => String(f(c)));
  };
  const queue = [[trigger, [{ json: {} }]]];
  let waited = 0;
  let steps = 0;
  const visited = [];
  while (queue.length) {
    if (++steps > 2000) throw new Error("runaway loop");
    const [name, input] = queue.shift();
    const node = byName[name];
    const p = node.parameters;
    const $runIndex = (runs[name] ?? []).length;
    const $json = input[0].json;
    let out;
    let branch = 0;
    visited.push(name);
    switch (node.type) {
      case "n8n-nodes-base.manualTrigger":
      case "n8n-nodes-base.scheduleTrigger":
        out = [{ json: {} }];
        break;
      case "n8n-nodes-base.set": {
        const o = p.includeOtherFields ? { ...$json } : {};
        for (const a of p.assignments.assignments)
          o[a.name] = ev(a.value, $json, $runIndex);
        out = [{ json: o }];
        break;
      }
      case "n8n-nodes-base.httpRequest": {
        const headers = Object.fromEntries(
          p.headerParameters.parameters.map((h) => [
            h.name,
            ev(h.value, $json, $runIndex),
          ]),
        );
        const req = {
          method: p.method,
          url: ev(p.url, $json, $runIndex),
          headers,
          body: p.sendBody ? ev(p.jsonBody, $json, $runIndex) : undefined,
          auth: Boolean(node.credentials?.httpHeaderAuth),
        };
        out = [{ json: api.handle(req) }];
        break;
      }
      case "n8n-nodes-base.if":
        branch =
          ev(p.conditions.conditions[0].leftValue, $json, $runIndex) === true
            ? 0
            : 1;
        out = input;
        break;
      case "n8n-nodes-base.switch": {
        const i = p.rules.values.findIndex(
          (r) =>
            ev(r.conditions.conditions[0].leftValue, $json, $runIndex) === true,
        );
        branch =
          i >= 0
            ? i
            : p.options.fallbackOutput === "extra"
              ? p.rules.values.length
              : -1;
        out = input;
        break;
      }
      case "n8n-nodes-base.wait": {
        const s = Number(ev(p.amount, $json, $runIndex));
        if (!(s >= 1 && s <= 300)) throw new Error(`bad wait ${s} at ${name}`);
        waited += s;
        out = input;
        break;
      }
      case "n8n-nodes-base.code": {
        const $input = { first: () => input[0], all: () => input };
        out = new Function("$input", "$", "$runIndex", p.jsCode)(
          $input,
          $,
          $runIndex,
        );
        break;
      }
      case "n8n-nodes-base.noOp":
        out = input;
        break;
      case "n8n-nodes-base.stopAndError":
        (runs[name] ??= []).push(input);
        return {
          stop: name,
          message: ev(p.errorMessage, $json, $runIndex),
          api,
          waited,
          runs,
          visited,
        };
      default:
        throw new Error(`unknown node ${node.type}`);
    }
    (runs[name] ??= []).push(out);
    if (branch >= 0)
      for (const e of edges.filter((x) => x.src === name && x.out === branch))
        queue.push([e.dst, out]);
  }
  return {
    stop: null,
    api,
    waited,
    runs,
    visited,
    summary: runs["Build Summary"]?.at(-1)[0].json,
  };
}

function scenarios(file, wf, edges, dryRun) {
  console.log(`  -- simulation (${dryRun ? "dry-run test" : "production"})`);
  const check = (label, cond, extra = "") => {
    if (cond) pass(label);
    else fail(`${label} ${extra}`);
  };
  const sim = (s, o = {}) => simulate(wf, edges, s, { dryRun, ...o });

  const ok = sim("happy");
  const keys = ok.api.calls.map((c) => c.key);
  check(
    "happy path ends at Sync Completed",
    ok.visited.at(-1) === "Sync Completed" && !ok.stop,
    ok.stop ?? "",
  );
  check(
    "call order: health → status → create → run → poll×3",
    JSON.stringify(keys) ===
      JSON.stringify([
        "GET /health",
        `GET /stores/${STORE}/status`,
        "POST /sync-jobs",
        "POST /sync-jobs/:id/run",
        "GET /sync-jobs/:id",
        "GET /sync-jobs/:id",
        "GET /sync-jobs/:id",
      ]),
    JSON.stringify(keys),
  );
  const create = ok.api.calls.find((c) => c.key === "POST /sync-jobs");
  const body = JSON.parse(create.body);
  check(
    `create body dry_run=${dryRun}, trigger_source=n8n, store_id`,
    body.dry_run === dryRun &&
      body.trigger_source === "n8n" &&
      body.store_id === STORE,
  );
  check(
    "Idempotency-Key + X-Request-ID from the execution id",
    create.headers["Idempotency-Key"] ===
      `n8n-4242-${dryRun ? "dryrun-create" : "create"}` &&
      create.headers["X-Request-ID"] === create.headers["Idempotency-Key"],
  );
  const run = ok.api.calls.find((c) => c.key === "POST /sync-jobs/:id/run");
  check(
    "Start Worker: POST /sync-jobs/{jobId}/run with X-Request-ID n8n-<exec>-run, authenticated",
    run.headers["X-Request-ID"] === "n8n-4242-run" &&
      run.auth &&
      run.body === undefined,
  );
  const pollIds = ok.api.calls
    .filter((c) => c.key === "GET /sync-jobs/:id")
    .map((c) => c.headers["X-Request-ID"]);
  check(
    "unique X-Request-ID per poll",
    new Set(pollIds).size === pollIds.length,
    pollIds.join(),
  );
  check(
    "no cancel call is ever made",
    !ok.api.calls.some((c) => c.key.endsWith("/cancel")),
  );
  const s = ok.summary;
  check(
    "summary has store_id, job_id, status, trigger_source, dry_run, progress, counts, timestamps, error",
    s &&
      [
        "store_id",
        "job_id",
        "status",
        "trigger_source",
        "dry_run",
        "progress",
        "counts",
        "started_at",
        "completed_at",
        "cancelled_at",
        "error",
      ].every((k) => k in s),
    JSON.stringify(s),
  );
  check(
    `summary dry_run=${dryRun}, status completed`,
    s.dry_run === dryRun && s.status === "completed",
  );
  check(
    "waits between polls use pollIntervalSeconds",
    ok.waited === 2 * (dryRun ? 10 : 30),
    `waited ${ok.waited}`,
  );

  if (!dryRun) {
    const sch = simulate(wf, edges, "happy", {
      dryRun,
      trigger: "Schedule Trigger",
    });
    check(
      "schedule trigger runs the same flow with trigger_source=scheduled",
      sch.visited.at(-1) === "Sync Completed" &&
        JSON.parse(sch.api.calls.find((c) => c.key === "POST /sync-jobs").body)
          .trigger_source === "scheduled",
    );
  }

  const expectStop = (scen, node, re, o) => {
    const r = sim(scen, o);
    check(
      `${scen} → ${node}`,
      r.stop === node && re.test(r.message),
      `${r.stop}: ${r.message}`,
    );
    return r;
  };
  const r502 = expectStop("health502", "Stop: API Error", /HTTP 502/);
  check(
    "502 retried at most maxRetries (3) times",
    r502.api.counts["GET /health"] === 4,
    r502.api.counts["GET /health"],
  );
  const net = sim("network");
  check(
    "network error retried then continues",
    net.visited.at(-1) === "Sync Completed" &&
      net.api.counts["GET /health"] === 2,
  );
  const r429 = sim("rate429");
  check(
    "429 honours Retry-After (7 s) then continues",
    r429.visited.at(-1) === "Sync Completed" &&
      r429.waited >= 7 &&
      r429.api.counts[`GET /stores/${STORE}/status`] === 2,
  );
  const r503 = sim("create503");
  check(
    "503 on create retried with the SAME Idempotency-Key (no duplicate job)",
    r503.visited.at(-1) === "Sync Completed" &&
      new Set(
        r503.api.calls
          .filter((c) => c.key === "POST /sync-jobs")
          .map((c) => c.headers["Idempotency-Key"]),
      ).size === 1,
  );
  expectStop("notReady", "Not Ready", /not ready for sync/);
  const r401 = expectStop(
    "unauth401",
    "Stop: API Auth Failure",
    /HTTP 401 INVALID_API_KEY .*request_id req-INVALID_API_KEY/,
  );
  check(
    "401 never retried",
    r401.api.counts[`GET /stores/${STORE}/status`] === 1,
  );
  expectStop("store404", "Stop: Store Not Found", /HTTP 404 STORE_NOT_FOUND/);
  if (dryRun) {
    // The dry-run TEST workflow must never start someone else's (possibly real) job.
    const r409 = expectStop(
      "active409",
      "Stop: Job Creation Conflict",
      /HTTP 409 SYNC_JOB_ALREADY_ACTIVE.*active job 99999999/,
    );
    check("409 never retried", r409.api.counts["POST /sync-jobs"] === 1);
    check(
      "dry-run test never calls /run on another active job",
      !r409.api.calls.some((c) => c.key.includes("/run")),
    );
  } else {
    for (const [scen, reason] of [
      ["active409", "already_running"],
      ["active409stale", "reclaimed"],
      ["active409finished", "finished"],
    ]) {
      const r = sim(scen);
      const runs = r.api.calls.filter((c) => c.key.endsWith("/run"));
      check(
        `stale-job recovery (${scen}): 409 + active_job_id → POST /run on THAT job (${reason}) → poll → Sync Completed`,
        r.visited.at(-1) === "Sync Completed" &&
          runs.length === 1 &&
          runs[0].key === "POST /sync-jobs/:active/run" &&
          r.summary.job_id === ACTIVE &&
          r.summary.recovered_active_job === true,
        `${r.stop ?? r.visited.at(-1)} ${JSON.stringify(r.summary ?? {})}`,
      );
      check(
        `stale-job recovery (${scen}): exactly one create attempt, no second job, never cancels`,
        r.api.counts["POST /sync-jobs"] === 1 &&
          !r.api.calls.some((c) => c.key.endsWith("/cancel")),
      );
    }
    const happy = sim("happy");
    check(
      "a normal run reports recovered_active_job=false",
      happy.summary.recovered_active_job === false,
    );
  }
  for (const [scen, re] of [
    ["active409noid", /HTTP 409 SYNC_JOB_ALREADY_ACTIVE/],
    ["idem409", /HTTP 409 IDEMPOTENCY_CONFLICT/],
  ]) {
    const r = expectStop(scen, "Stop: Job Creation Conflict", re);
    check(
      `${scen}: no /run call, create not retried`,
      !r.api.calls.some((c) => c.key.includes("/run")) &&
        r.api.counts["POST /sync-jobs"] === 1,
    );
  }
  expectStop(
    "start500",
    "Stop: Worker Start Failure",
    /Start Worker: HTTP 500 INTERNAL_ERROR/,
  );
  expectStop(
    "start404",
    "Stop: Worker Start Failure",
    /HTTP 404 JOB_NOT_FOUND/,
  );
  const p503 = sim("poll503");
  check(
    "transient poll error (503) keeps polling and honours Retry-After (45 s)",
    p503.visited.at(-1) === "Sync Completed" && p503.waited >= 45,
  );
  expectStop(
    "cancelled",
    "Stop: Job Cancelled",
    /cancelled.*Completed uploads were kept/,
  );
  expectStop("failed", "Stop: Job Failed", /failed.*GOOGLE_DRIVE_UNAVAILABLE/);
  const partial = sim("partial");
  check(
    "completed_with_errors → Sync Completed with failed count",
    partial.visited.at(-1) === "Sync Completed" &&
      partial.summary.progress.failed === 1,
  );
  const to = expectStop(
    "pollTimeout",
    "Stop: Poll Timeout",
    /did not finish within .*NOT cancelled/,
  );
  const max = wf.nodes
    .find((n) => n.name === "Config")
    .parameters.assignments.assignments.find(
      (a) => a.name === "maxPolls",
    ).value;
  check(
    `polling bounded (${max} polls) and never cancels`,
    to.api.counts["GET /sync-jobs/:id"] === max &&
      !to.api.calls.some((c) => c.key.endsWith("/cancel")),
    to.api.counts["GET /sync-jobs/:id"],
  );
}

for (const [file, expect] of [
  [
    "product-image-sync-production.workflow.json",
    {
      name: "Product Image Sync — Production",
      triggers: ["Manual Trigger", "Schedule Trigger"],
      dryRun: false,
    },
  ],
  [
    "product-image-sync-dry-run-test.workflow.json",
    {
      name: "Product Image Sync — Dry Run Test",
      triggers: ["Manual Trigger"],
      dryRun: true,
    },
  ],
]) {
  const full = path.join(root, "docs", "n8n", file);
  const { wf, edges } = validate(full, expect);
  scenarios(full, wf, edges, expect.dryRun);
}
console.log(
  failures
    ? `\n${failures} check(s) FAILED`
    : "\nall n8n workflow checks passed",
);
process.exit(failures ? 1 : 0);
