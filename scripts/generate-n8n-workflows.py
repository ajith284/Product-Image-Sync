#!/usr/bin/env python3
"""Generates the importable n8n workflows for Product Image Sync (Prompt 13).

  python3 scripts/generate-n8n-workflows.py
    → docs/n8n/product-image-sync-production.workflow.json   ("Product Image Sync — Production")
    → docs/n8n/product-image-sync-dry-run-test.workflow.json ("Product Image Sync — Dry Run Test")

Flow (both):
  Manual Trigger / Schedule Trigger (production only) → Config → Health → Store Status → Ready?
  → Create Sync Job → Start Worker → Poll Job ⟲ (Wait) → Build Summary → Job Result
      completed / completed_with_errors → Sync Completed
      cancelled → Stop: Job Cancelled          failed → Stop: Job Failed
  Errors: Not Ready, API Auth Failure, Store Not Found, Job Creation Conflict,
          Worker Start Failure, Poll Timeout, other API error.

Every API call: <HTTP> (full response, never throws, continues on network errors)
  → <Step> Retry? — 429/502/503/504 or network error, at most Config.maxRetries times
      true  → <Step> Retry Wait (Retry-After, else 2^n s; clamped 1–60 s) → back to <HTTP>
      false → Check <Step> (normalises: ok, http_status, code, message, request_id)
  → <Step> OK? — false → API Error Type (Switch) → the matching Stop node.
Stale-job recovery (production only, Prompt 14E): when create returns 409
SYNC_JOB_ALREADY_ACTIVE with an active_job_id, that job becomes this run's job and goes
through the normal Start Worker → poll path. POST /run stays authoritative: live lease →
already_running (just wait), stale lease → reclaimed, finished → nothing re-run. No second
job is ever created. The dry-run TEST workflow still stops on a conflict (it must never
start a queued real sync).
401/403/404/409/422 are never retried. Polling: transient poll errors count as "not
finished yet"; the loop is bounded by Config.maxPolls and Config.maxPollMinutes.

The API secret lives only in the n8n credential "Product Image Sync API" (Header Auth),
referenced by NAME. No secret, token or credential ID is written to the files.
"""
import json
import os
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRED = {"httpHeaderAuth": {"name": "Product Image Sync API"}}
BASE = "https://reach-rental-heat.ngrok-free.dev/api/n8n/v1"
STORE = "7bb362f0-ce91-4b0b-a81b-373d49f2b242"
CFG = "$('Config').first().json"


class WF:
    def __init__(self, ns):
        self.ns = uuid.UUID(ns)
        self.nodes, self.conns = [], {}

    def nid(self, name):
        return str(uuid.uuid5(self.ns, name))

    def add(self, name, type_, version, params, pos, **extra):
        node = {"parameters": params, "id": self.nid(name), "name": name, "type": type_, "typeVersion": version, "position": pos}
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, src, dst, out=0):
        outs = self.conns.setdefault(src, {"main": []})["main"]
        while len(outs) <= out:
            outs.append([])
        outs[out].append({"node": dst, "type": "main", "index": 0})

    # ---- node helpers -----------------------------------------------------
    def http(self, name, method, url, pos, auth=True, headers=(), json_body=None):
        params = {"method": method, "url": url}
        if auth:
            params["authentication"] = "genericCredentialType"
            params["genericAuthType"] = "httpHeaderAuth"
        params["sendHeaders"] = True
        params["headerParameters"] = {
            "parameters": [{"name": "ngrok-skip-browser-warning", "value": "true"}]
            + [{"name": k, "value": v} for k, v in headers]
        }
        if json_body is not None:
            params["sendBody"] = True
            params["specifyBody"] = "json"
            params["jsonBody"] = json_body
        params["options"] = {
            "response": {"response": {"fullResponse": True, "neverError": True, "responseFormat": "json"}},
            "timeout": 20000,
        }
        extra = {"credentials": CRED} if auth else {}
        # Network errors (DNS, timeout) continue as an item with no statusCode → retried, then reported.
        return self.add(name, "n8n-nodes-base.httpRequest", 4.2, params, pos, onError="continueRegularOutput", **extra)

    def cond(self, key, expr):
        return {
            "id": self.nid(key),
            "leftValue": expr,
            "rightValue": "",
            "operator": {"type": "boolean", "operation": "true", "singleValue": True},
        }

    def conditions(self, key, expr):
        return {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [self.cond(key, expr)],
            "combinator": "and",
        }

    def if_node(self, name, expr, pos):
        return self.add(name, "n8n-nodes-base.if", 2.2,
                        {"conditions": self.conditions(name + "-cond", expr), "looseTypeValidation": True, "options": {}}, pos)

    def switch(self, name, rules, pos, fallback=None):
        values = [{"conditions": self.conditions(f"{name}-{key}", expr), "renameOutput": True, "outputKey": key} for key, expr in rules]
        options = {}
        if fallback:
            options = {"fallbackOutput": "extra", "renameFallbackOutput": fallback}
        return self.add(name, "n8n-nodes-base.switch", 3.2, {"rules": {"values": values}, "looseTypeValidation": True, "options": options}, pos)

    def code(self, name, js, pos):
        return self.add(name, "n8n-nodes-base.code", 2, {"jsCode": js}, pos)

    def stop(self, name, message, pos):
        return self.add(name, "n8n-nodes-base.stopAndError", 1, {"errorMessage": message}, pos)

    def wait(self, name, amount_expr, pos):
        return self.add(name, "n8n-nodes-base.wait", 1.1, {"amount": amount_expr, "unit": "seconds"}, pos,
                        webhookId=self.nid(name + "-webhook"))

    def note(self, name, content, pos, w=420, h=300, color=7):
        return self.add(name, "n8n-nodes-base.stickyNote", 1, {"content": content, "height": h, "width": w, "color": color}, pos)


# Shared Code-node prelude: reads ONLY the HTTP status, safe headers and the API body.
CHECK_HEAD = """// Reads only the API response (status, body, retry-after). Never reads or returns credentials.
const r = $input.first().json || {};
const status = Number(r.statusCode) || 0;
let body = r.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
body = body && typeof body === 'object' ? body : {};
const headers = r.headers || {};
const err = body.error || {};
const safe = (v, n = 300) => (v === undefined || v === null ? null : String(v).slice(0, n));
const failure = (code, message) => [{ json: {
  ok: false,
  step: STEP,
  http_status: status,
  code: safe(err.code || code, 60),
  message: safe(err.message || message),
  request_id: safe(err.request_id || headers['x-request-id'], 100),
  active_job_id: safe(err.active_job_id, 36),
} }];
if (!status) return failure('NETWORK_ERROR', 'The Product Image Sync API could not be reached (network error or timeout).');
"""


# Production only: a still-active job (409 + active_job_id) is resumed via /run instead of
# stopping the run. Only this exact error qualifies; IDEMPOTENCY_CONFLICT etc. still stop.
RECOVER_ACTIVE = """
if (status === 409 && err.code === 'SYNC_JOB_ALREADY_ACTIVE'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(err.active_job_id || ''))) {
  return [{ json: {
    ok: true,
    recovered: true,
    job_id: String(err.active_job_id).toLowerCase(),
    store_id: $('Config').first().json.storeId,
    status: 'active',
    dry_run: null,
    trigger_source: null,
    replayed: false,
    request_id: safe(err.request_id || headers['x-request-id'], 100),
  } }];
}
"""


def check_js(step, tail):
    return CHECK_HEAD.replace("STEP", json.dumps(step)) + tail


def api_step(wf, step, method, url, x, y, check_tail, auth=True, headers=(), json_body=None):
    """HTTP → Retry? ⟲ Retry Wait → Check → OK?   Returns (entry, ok_if)."""
    first = wf.http(step, method, url, [x, y], auth, headers, json_body)
    retry_if = wf.if_node(
        f"{step} Retry?",
        f"={{{{ ([429, 502, 503, 504].includes(Number($json.statusCode)) || !$json.statusCode) && $runIndex < {CFG}.maxRetries }}}}",
        [x + 220, y],
    )
    wait = wf.wait(
        f"{step} Retry Wait",
        "={{ Math.min(Math.max(Number(($json.headers || {})['retry-after']) || Math.pow(2, $runIndex + 1), 1), 60) }}",
        [x + 220, y - 200],
    )
    chk = wf.code(f"Check {step}", check_js(step, check_tail), [x + 440, y])
    ok = wf.if_node(f"{step} OK?", "={{ $json.ok === true }}", [x + 660, y])
    wf.link(first, retry_if)
    wf.link(retry_if, wait, 0)
    wf.link(wait, first)            # bounded loop: Retry? counts its own runs
    wf.link(retry_if, chk, 1)
    wf.link(chk, ok)
    wf.link(ok, "API Error Type", 1)
    return first, ok


def build(mode):
    prod = mode == "production"
    wf = WF("6f1d1a10-9b00-4a00-9000-0000000000%02d" % (13 if prod else 14))
    name = "Product Image Sync — Production" if prod else "Product Image Sync — Dry Run Test"
    tag = "create" if prod else "dryrun-create"

    # ---- documentation -------------------------------------------------------
    wf.note("Note: About", (
        f"## {name}\n"
        + ("Creates a REAL sync job (dry_run=false), starts the server-side worker, polls until it finishes.\n\n"
           if prod else
           "TEST ONLY. Creates a DRY-RUN job (dry_run=true): Drive scan + Shopify matching + image metadata.\n"
           "No image download, no Shopify upload, no Drive/Shopify changes.\n\n")
        + "n8n only calls the Product Image Sync API with the **Product Image Sync API** Header Auth credential. "
          "Google and Shopify tokens never leave the server.\n\n"
          "**baseUrl in Config is DEVELOPMENT ONLY (ngrok).** Replace it with the production API URL before activating."
    ), [-460, -420], 420, 340, 5 if prod else 3)
    if prod:
        wf.note("Note: Schedule", (
            "## Schedule (conservative default)\n"
            "Once a day at **02:00 Asia/Kolkata** (workflow timezone setting).\n\n"
            "The workflow is imported **inactive** — the schedule does nothing until you activate it. "
            "Only one job per store can be active. If a job is still active when this runs (409), the workflow "
            "does NOT create another one: it calls **/run** on that job instead — a live worker → it just waits "
            "for that job; a dead worker (stale lease, 15 min) → the job is reclaimed and resumed without "
            "duplicate uploads. The summary then shows `recovered_active_job: true`."
        ), [-460, 260], 420, 260, 6)

    # ---- triggers + config ---------------------------------------------------
    wf.add("Manual Trigger", "n8n-nodes-base.manualTrigger", 1, {}, [0, 0])
    if prod:
        wf.add("Schedule Trigger", "n8n-nodes-base.scheduleTrigger", 1.2, {
            "rule": {"interval": [{"field": "days", "daysInterval": 1, "triggerAtHour": 2, "triggerAtMinute": 0}]},
        }, [0, 200])

    def a(name_, value, type_="string"):
        return {"id": wf.nid("cfg-" + name_), "name": name_, "value": value, "type": type_}

    trigger = "={{ $('Schedule Trigger').isExecuted ? 'scheduled' : 'n8n' }}" if prod else "n8n"
    wf.add("Config", "n8n-nodes-base.set", 3.4, {
        "mode": "manual",
        "assignments": {"assignments": [
            a("baseUrl", BASE),
            a("baseUrlNote", "DEVELOPMENT ONLY — ngrok tunnel. Replace baseUrl with the production API URL."),
            a("storeId", STORE),
            a("triggerSource", trigger),
            a("dryRun", not prod, "boolean"),
            a("maxRetries", 3, "number"),
            a("pollIntervalSeconds", 30 if prod else 10, "number"),
            a("maxPolls", 240 if prod else 60, "number"),
            a("maxPollMinutes", 120 if prod else 15, "number"),
        ]},
        "includeOtherFields": False,
        "options": {},
    }, [220, 0])
    wf.link("Manual Trigger", "Config")
    if prod:
        wf.link("Schedule Trigger", "Config")

    # ---- error routing (shared) ----------------------------------------------
    wf.switch("API Error Type", [
        ("auth", "={{ [401, 403].includes(Number($json.http_status)) }}"),
        ("store_not_found", "={{ $json.code === 'STORE_NOT_FOUND' }}"),
        ("job_conflict", "={{ $json.step === 'Create Sync Job' && [409, 422].includes(Number($json.http_status)) }}"),
        ("worker_start", "={{ $json.step === 'Start Worker' }}"),
    ], [3800, 900], fallback="other")
    detail = "' + ' at ' + $json.step + ': HTTP ' + $json.http_status + ' ' + $json.code + ' — ' + $json.message + ' [request_id ' + $json.request_id + ']'"
    wf.stop("Stop: API Auth Failure", "={{ 'Product Image Sync API authentication failed (check the \"Product Image Sync API\" credential and its scopes)" + detail + " }}", [4080, 640])
    wf.stop("Stop: Store Not Found", "={{ 'Store not found or not accessible with this API key" + detail + " }}", [4080, 800])
    wf.stop("Stop: Job Creation Conflict", "={{ 'Sync job not created" + detail + " + ($json.active_job_id ? ' (active job ' + $json.active_job_id + ')' : '') }}", [4080, 960])
    wf.stop("Stop: Worker Start Failure", "={{ 'The sync worker could not be started" + detail + " }}", [4080, 1120])
    wf.stop("Stop: API Error", "={{ 'Product Image Sync API error" + detail + " }}", [4080, 1280])
    for i, n in enumerate(["Stop: API Auth Failure", "Stop: Store Not Found", "Stop: Job Creation Conflict", "Stop: Worker Start Failure", "Stop: API Error"]):
        wf.link("API Error Type", n, i)

    # ---- 1. health (public) --------------------------------------------------
    h_in, h_ok = api_step(wf, "Health", "GET", f"={{{{ {CFG}.baseUrl }}}}/health", 440, 0, auth=False,
                          headers=(("X-Request-ID", "=n8n-{{ $execution.id }}-health"),), check_tail="""
if (status !== 200 || body.ok !== true) return failure('HEALTH_FAILED', 'The API health check failed.');
return [{ json: { ok: true, service: safe(body.service, 60), version: safe(body.version, 40) } }];
""")
    wf.link("Config", h_in)

    # ---- 2. store status -----------------------------------------------------
    s_in, s_ok = api_step(wf, "Store Status", "GET", f"={{{{ {CFG}.baseUrl }}}}/stores/{{{{ {CFG}.storeId }}}}/status", 1340, 0,
                          headers=(("X-Request-ID", "=n8n-{{ $execution.id }}-status"),), check_tail="""
if (status !== 200) return failure('STORE_STATUS_FAILED', 'The store status could not be read.');
const shopify = body.shopify || {};
const drive = body.google_drive || {};
return [{ json: {
  ok: true,
  store_id: body.store_id,
  store_name: safe(body.store_name, 120),
  shopify_connected: shopify.connected === true,
  shopify_status: safe(shopify.status, 40),
  google_drive_connected: drive.connected === true,
  root_folder_selected: drive.root_folder_selected === true,
  ready_for_sync: body.ready_for_sync === true,
} }];
""")
    wf.link(h_ok, s_in, 0)

    wf.if_node("Ready?", "={{ $json.ready_for_sync === true }}", [2240, 0])
    wf.stop("Not Ready", "={{ 'Store ' + $json.store_id + ' is not ready for sync: shopify_connected=' + $json.shopify_connected + ' (' + $json.shopify_status + '), google_drive_connected=' + $json.google_drive_connected + ', root_folder_selected=' + $json.root_folder_selected }}", [2460, 220])
    wf.link(s_ok, "Ready?", 0)
    wf.link("Ready?", "Not Ready", 1)

    # ---- 3. create job ---------------------------------------------------------
    c_in, c_ok = api_step(
        wf, "Create Sync Job", "POST", f"={{{{ {CFG}.baseUrl }}}}/sync-jobs", 2460, 0,
        headers=(
            ("Content-Type", "application/json"),
            ("Idempotency-Key", f"=n8n-{{{{ $execution.id }}}}-{tag}"),
            ("X-Request-ID", f"=n8n-{{{{ $execution.id }}}}-{tag}"),
        ),
        json_body=f"={{{{ JSON.stringify({{ store_id: {CFG}.storeId, trigger_source: {CFG}.triggerSource, dry_run: {CFG}.dryRun }}) }}}}",
        check_tail=(RECOVER_ACTIVE if prod else "") + f"""
if (status !== 201 && status !== 200) return failure('CREATE_FAILED', 'The sync job could not be created.');
if (body.dry_run !== {'false' if prod else 'true'}) return failure('UNEXPECTED_MODE', 'The created job has the wrong dry_run mode.');
return [{{ json: {{
  ok: true,
  job_id: body.job_id,
  store_id: body.store_id,
  status: body.status,
  dry_run: body.dry_run,
  trigger_source: body.trigger_source,
  replayed: String(headers['idempotent-replayed'] || '') === 'true',
  recovered: false,
}} }}];
""",
    )
    wf.link("Ready?", c_in, 0)
    JOB = f"$('Check Create Sync Job').first().json.job_id"

    # ---- 4. start worker -------------------------------------------------------
    w_in, w_ok = api_step(
        wf, "Start Worker", "POST", f"={{{{ {CFG}.baseUrl }}}}/sync-jobs/{{{{ {JOB} }}}}/run", 3360, 0,
        headers=(("X-Request-ID", "=n8n-{{ $execution.id }}-run"),),
        check_tail="""
// 202 claimed / reclaimed = worker started. 200 already_running = a worker already holds the job
// (e.g. a retried request); 200 finished = the job already ended. Polling reports the outcome either way.
if (status !== 202 && status !== 200) return failure('WORKER_START_FAILED', 'The sync worker could not be started.');
return [{ json: {
  ok: true,
  job_id: body.job_id,
  status: body.status,
  claimed: body.claimed === true,
  reason: safe(body.reason, 40),
  poll_started_at: Date.now(),
} }];
""",
    )
    wf.link(c_ok, w_in, 0)

    # ---- 5. poll ----------------------------------------------------------------
    poll = wf.http("Poll Job", "GET", f"={{{{ {CFG}.baseUrl }}}}/sync-jobs/{{{{ {JOB} }}}}", [4260, 0],
                   headers=(("X-Request-ID", "=n8n-{{ $execution.id }}-poll-{{ $runIndex }}"),))
    wf.code("Check Job", check_js("Poll Job", """
// 429 / 5xx / network errors while polling = "not finished yet": the poll loop retries (bounded).
if (!status || [429, 502, 503, 504].includes(status)) {
  return [{ json: { ok: true, finished: false, transient: true, http_status: status, poll: $runIndex + 1,
                    retry_after: Number(headers['retry-after']) || null } }];
}
if (status !== 200) return failure('POLL_FAILED', 'The sync job could not be read.');
const terminal = ['completed', 'completed_with_errors', 'failed', 'cancelled'];
return [{ json: {
  ok: true,
  finished: terminal.includes(body.status),
  transient: false,
  poll: $runIndex + 1,
  retry_after: Number(headers['retry-after']) || null,
  job: {
    job_id: body.job_id,
    store_id: body.store_id,
    status: body.status,
    trigger_source: body.trigger_source,
    dry_run: body.dry_run,
    cancel_requested: body.cancel_requested === true,
    progress: body.progress || {},
    result: body.result || {},
    error: body.error || null,
    started_at: body.started_at || null,
    completed_at: body.completed_at || null,
    cancelled_at: body.cancelled_at || null,
  },
} }];
""").replace("if (!status) return failure('NETWORK_ERROR', 'The Product Image Sync API could not be reached (network error or timeout).');\n", ""),
            [4480, 0])
    wf.if_node("Poll OK?", "={{ $json.ok === true }}", [4700, 0])
    wf.if_node("Job Finished?", "={{ $json.finished === true }}", [4920, 0])
    wf.if_node("Poll Limit Reached?",
               f"={{{{ $runIndex + 1 >= {CFG}.maxPolls || Date.now() - $('Check Start Worker').first().json.poll_started_at > {CFG}.maxPollMinutes * 60000 }}}}",
               [5140, 220])
    wf.stop("Stop: Poll Timeout",
            f"={{{{ 'Sync job ' + {JOB} + ' did not finish within ' + {CFG}.maxPolls + ' polls / ' + {CFG}.maxPollMinutes + ' minutes. The job keeps running on the server — check it later with GET /sync-jobs/{{jobId}}. It was NOT cancelled.' }}}}",
            [5360, 420])
    wf.wait("Wait Before Next Poll",
            f"={{{{ Math.min(Math.max(Number($('Check Job').last().json.retry_after) || {CFG}.pollIntervalSeconds, 5), 300) }}}}",
            [5360, 220])
    wf.link(w_ok, poll, 0)
    wf.link(poll, "Check Job")
    wf.link("Check Job", "Poll OK?")
    wf.link("Poll OK?", "Job Finished?", 0)
    wf.link("Poll OK?", "API Error Type", 1)
    wf.link("Job Finished?", "Poll Limit Reached?", 1)
    wf.link("Poll Limit Reached?", "Stop: Poll Timeout", 0)
    wf.link("Poll Limit Reached?", "Wait Before Next Poll", 1)
    wf.link("Wait Before Next Poll", poll)

    # ---- 6. summary + result ---------------------------------------------------
    wf.code("Build Summary", """// Safe job summary only: IDs, status, counts, timestamps, safe error code/message.
const j = $input.first().json.job || {};
const p = j.progress || {};
const res = j.result || {};
const err = j.error && typeof j.error === 'object' ? { code: j.error.code || null, message: j.error.message || null } : null;
return [{ json: {
  store_id: j.store_id,
  job_id: j.job_id,
  status: j.status,
  trigger_source: j.trigger_source,
  dry_run: j.dry_run === true,
  progress: {
    total: p.total ?? 0, processed: p.processed ?? 0, uploaded: p.uploaded ?? 0,
    skipped: p.skipped ?? 0, review: p.review ?? 0, failed: p.failed ?? 0,
  },
  counts: {
    products: res.products ?? p.total ?? 0,
    uploaded: res.uploaded ?? p.uploaded ?? 0,
    skipped: res.skipped ?? p.skipped ?? 0,
    blocked: res.blocked ?? 0,
    review: res.review ?? p.review ?? 0,
    failed: res.failed ?? p.failed ?? 0,
    warnings: Array.isArray(res.warnings) ? res.warnings.length : 0,
    ...(res.plan ? { would_upload: res.plan.would_upload ?? 0 } : {}),
  },
  review_items: Array.isArray(res.review_items) ? res.review_items.slice(0, 50) : [],
  failed_items: Array.isArray(res.failed_items) ? res.failed_items.slice(0, 50) : [],
  started_at: j.started_at,
  completed_at: j.completed_at,
  cancelled_at: j.cancelled_at,
  error: err,
  polls: $input.first().json.poll ?? null,
  recovered_active_job: $('Check Create Sync Job').first().json.recovered === true,
} }];
""", [5140, -200])
    wf.switch("Job Result", [
        ("completed", "={{ ['completed', 'completed_with_errors'].includes($json.status) }}"),
        ("cancelled", "={{ $json.status === 'cancelled' }}"),
        ("failed", "={{ $json.status === 'failed' }}"),
    ], [5360, -200])
    wf.add("Sync Completed", "n8n-nodes-base.noOp", 1, {}, [5640, -400])
    summary_txt = "' (job ' + $json.job_id + ', store ' + $json.store_id + '): processed ' + $json.progress.processed + '/' + $json.progress.total + ', uploaded ' + $json.progress.uploaded + ', skipped ' + $json.progress.skipped + ', review ' + $json.progress.review + ', failed ' + $json.progress.failed"
    wf.stop("Stop: Job Cancelled", "={{ 'Sync job was cancelled' + " + summary_txt + " + '. Completed uploads were kept.' }}", [5640, -200])
    wf.stop("Stop: Job Failed", "={{ 'Sync job failed' + " + summary_txt + " + ($json.error ? ' — ' + $json.error.code + ': ' + $json.error.message : '') + '. Completed uploads were kept.' }}", [5640, 0])
    wf.link("Job Finished?", "Build Summary", 0)
    wf.link("Build Summary", "Job Result")
    wf.link("Job Result", "Sync Completed", 0)
    wf.link("Job Result", "Stop: Job Cancelled", 1)
    wf.link("Job Result", "Stop: Job Failed", 2)

    return {
        "name": name,
        "nodes": wf.nodes,
        "connections": wf.conns,
        "active": False,
        "settings": {"executionOrder": "v1", "saveManualExecutions": True, "timezone": "Asia/Kolkata"} if prod
        else {"executionOrder": "v1", "saveManualExecutions": True},
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": False},
        "tags": [],
    }


if __name__ == "__main__":
    for mode, file in (("production", "product-image-sync-production.workflow.json"),
                       ("dry_run_test", "product-image-sync-dry-run-test.workflow.json")):
        wf = build(mode)
        path = os.path.join(ROOT, "docs", "n8n", file)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(wf, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"{file}: {len(wf['nodes'])} nodes")
