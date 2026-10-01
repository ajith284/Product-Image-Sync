# Product Image Sync API for n8n (v1)

Machine-to-machine API between Product Image Sync and n8n (and future workers).

n8n gets **only** a Product Image Sync API key — never Shopify, Google, or Supabase credentials. `POST /sync-jobs` only queues a job; Prompt 13 starts the server-side worker with `POST /sync-jobs/:jobId/run`.

```text
Base URL: https://YOUR-APP-DOMAIN/api/n8n/v1
          (dev: https://<your-ngrok-domain>/api/n8n/v1)
```

## 1. Create an API key

App → **Settings → API keys** (owners/admins) → name it (for example, `n8n Production`) → choose **All stores** or **Only <store>** → pick permissions → optional expiry → **Create API key**.

You see two values **once**:

| Value | Format | Use |
|---|---|---|
| Secret | `pis_live_<12 chars>_<43 chars>` | `Authorization: Bearer <secret>` on every request |
| Signing key | 64 hex chars | Only if you sign requests (section 4) |

The server stores only `SHA-256(secret)`. Lost secret → revoke the key and create a new one. Revocation takes effect on the next request.

### Scopes

| Scope | Allows |
|---|---|
| `n8n:read` | `GET /stores/:storeId/status` |
| `n8n:sync` | `POST /sync-jobs` (queue a job), `POST /sync-jobs/:jobId/run` (start/reclaim worker) |
| `n8n:jobs` | `GET /sync-jobs`, `GET /sync-jobs/:jobId`, `POST /sync-jobs/:jobId/cancel` |

Authorization is resolved **server-side from the key**: key → workspace → optional store restriction → requested store. A `workspace_id` (or any unknown field) in a request body is rejected.

## 2. Headers

| Header | Required | Notes |
|---|---|---|
| `Authorization: Bearer <secret>` | yes, except `/health` | Browser cookies are ignored. |
| `Content-Type: application/json` | for bodies | Max body 16 KB. |
| `Idempotency-Key` | **yes** for `POST /sync-jobs` | 1–200 chars: `A-Z a-z 0-9 . _ : -`. In n8n: `n8n-{{ $execution.id }}-create`. |
| `X-Request-ID` | optional; required when signing | 8–100 chars: `A-Z a-z 0-9 . _ : -`. Echoed back; generated if missing. |
| `X-PIS-Timestamp`, `X-PIS-Signature` | optional | Request signing, section 4. |

Every response has `X-Request-ID` and `Cache-Control: no-store`.

## 3. Endpoints

### `GET /health` — public

```json
{ "ok": true, "service": "product-image-sync", "version": "v1" }
```

Decision: **public** so n8n/uptime checks work without a key. It is static: no database access, no store/workspace data, and nothing to probe.

### `GET /stores/:storeId/status` — `n8n:read`

```json
{
  "store_id": "7bb362f0-…",
  "store_name": "BrandSure",
  "shopify": {
    "connected": true,
    "status": "connected",
    "shop_domain": "psvft1-0d.myshopify.com",
    "last_verified_at": "…"
  },
  "google_drive": {
    "connected": true,
    "status": "connected",
    "root_folder_selected": true,
    "root_folder_id": "1AbC…",
    "root_folder_name": "Sofa",
    "last_verified_at": "…"
  },
  "ready_for_sync": true
}
```

### `POST /sync-jobs` — `n8n:sync` (+ `Idempotency-Key`)

Queues a job. **Does not run a sync.**

```json
{
  "store_id": "7bb362f0-…",
  "trigger_source": "n8n",
  "dry_run": false,
  "category": "Sofa",
  "folder_id": "1AbC…"
}
```

`trigger_source`: `n8n` (default) | `scheduled` | `api`. `dry_run`, `category`, and `folder_id` are optional.

Checks: key, workspace, store, Shopify connected, Drive connected, root folder selected.

- `201` new job.
- `200` + `Idempotent-Replayed: true` for a retry with the same key and body.
- `409 IDEMPOTENCY_CONFLICT` for the same key with a different body or store.
- `409 SYNC_JOB_ALREADY_ACTIVE` (+ `active_job_id`) when one queued/running job already exists for the store.
- `409 SHOPIFY_NOT_CONNECTED | GOOGLE_DRIVE_NOT_CONNECTED | GOOGLE_DRIVE_ROOT_NOT_SELECTED` when required integrations are not ready.

Job object (also returned by the endpoints below):

```json
{
  "job_id": "…",
  "store_id": "…",
  "status": "queued",
  "trigger_source": "n8n",
  "dry_run": false,
  "options": { "category": "Sofa" },
  "cancel_requested": false,
  "progress": {
    "total": 0,
    "processed": 0,
    "uploaded": 0,
    "skipped": 0,
    "review": 0,
    "failed": 0
  },
  "counts": {
    "products_processed": 0,
    "products_synced": 0,
    "images_uploaded": 0,
    "warnings": 0,
    "errors": 0
  },
  "error": null,
  "created_at": "…",
  "started_at": null,
  "completed_at": null,
  "cancelled_at": null
}
```

Statuses: `queued`, `running`, `completed`, `completed_with_errors`, `failed`, `cancelled`.

### `POST /sync-jobs/:jobId/run` — `n8n:sync` (Prompt 13)

Starts the server-side worker for a job. No body is needed. Any body is ignored; Shopify or Google tokens, store IDs, and options are never accepted.

API key → workspace → store restriction → job is checked in the database. Another workspace's job returns `404`.

| Response | Meaning |
|---|---|
| `202` `{ …job, "claimed": true, "reason": "claimed" }` | Worker started (`queued → running`). |
| `202` `{ …, "claimed": true, "reason": "reclaimed" }` | Previous worker stopped responding; a new worker took over after lease expiry. |
| `200` `{ …, "claimed": false, "reason": "already_running" }` | A worker already holds the job; nothing new starts. |
| `200` `{ …, "claimed": false, "reason": "finished" }` | Job already completed, failed, or was cancelled. |

Only one worker can hold a job. The lease is 15 minutes and is refreshed on every checkpoint. The worker runs after the response is sent (Next.js `after()`); poll `GET /sync-jobs/:jobId` for progress.

Calling `/run` twice is safe. On serverless hosting, the route's `maxDuration` (800 s) bounds one run. A job cut off by the platform can be reclaimed by the next `/run` call after the lease expires and continues without duplicating uploads.

### `GET /sync-jobs/:jobId` — `n8n:jobs`

Job JSON includes `progress` (`total, processed, uploaded, skipped, review, failed`) updated by the worker, `error` (`code`, `message`), and `result` (counts, `blocked`, `review_items`, `failed_items`, `warnings`; dry runs add `plan.would_upload / skipped / blocked / review / failed`).

### `GET /sync-jobs?store_id=&status=&limit=&cursor=` — `n8n:jobs`

Newest first. `limit` is 1–100 (default 20). Response:

```json
{ "data": ["jobs"], "next_cursor": "…" }
```

`next_cursor` is `null` when there is no next page. Pass `cursor=<next_cursor>` for the next page.

### `POST /sync-jobs/:jobId/cancel` — `n8n:jobs`

`queued` → `cancelled`; `running` → `cancel_requested: true`. The worker stops starting new work, keeps completed uploads, and finishes `cancelled`.

Cancelling again returns `200` with `"changed": false`. Finished jobs return `409 JOB_NOT_CANCELLABLE`.

## 4. Optional request signing (HMAC-SHA256)

Signing proves the body/path were not altered and blocks replays. Unsigned requests are accepted unless the server sets `N8N_API_REQUIRE_SIGNATURE=true`.

Headers: `X-PIS-Timestamp` (Unix seconds, ±300 s), `X-Request-ID` (unique per request; used as the nonce and remembered for 10 minutes), `X-PIS-Signature`.

```text
canonical = "v1" + "\n" +
            X-PIS-Timestamp + "\n" +
            HTTP_METHOD (uppercase) + "\n" +
            path + query            (e.g. /api/n8n/v1/sync-jobs?limit=20) + "\n" +
            hex(SHA-256(raw body))   (empty body → e3b0c442…b855) + "\n" +
            X-Request-ID

X-PIS-Signature = "v1=" + hex(HMAC-SHA256(key = <signing key>, message = canonical))
```

The signing key is the 64-hex value shown at creation (= `SHA-256(secret)`). Still send `Authorization: Bearer <secret>`.

In n8n, use a **Crypto** node (Hash SHA256 of the body; Hmac SHA256 with the signing key) or a Code node with `crypto`.

Errors: `REQUEST_EXPIRED` (timestamp), `INVALID_SIGNATURE`, `REPLAYED_REQUEST` (all `401`).

## 5. Errors

```json
{
  "error": {
    "code": "STORE_NOT_FOUND",
    "message": "The requested store was not found.",
    "request_id": "req_…"
  }
}
```

| HTTP | Codes |
|---|---|
| 400 | `INVALID_JSON` |
| 401 | `INVALID_API_KEY`, `INVALID_SIGNATURE`, `REQUEST_EXPIRED`, `REPLAYED_REQUEST` |
| 403 | `INSUFFICIENT_SCOPE` |
| 404 | `STORE_NOT_FOUND`, `JOB_NOT_FOUND` (also for other workspaces' IDs) |
| 409 | `IDEMPOTENCY_CONFLICT`, `SYNC_JOB_ALREADY_ACTIVE`, `JOB_NOT_CANCELLABLE`, `SHOPIFY_NOT_CONNECTED`, `GOOGLE_DRIVE_NOT_CONNECTED`, `GOOGLE_DRIVE_ROOT_NOT_SELECTED` |
| 413 / 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `INVALID_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED` |
| 429 | `RATE_LIMITED` (+ `Retry-After` seconds) |
| 500 / 503 | `INTERNAL_ERROR`, `NOT_CONFIGURED` |

No stack traces, database errors, or credentials are ever returned.

## 6. Rate limits (fixed 60-second windows)

| Bucket | Limit |
|---|---|
| Per key — reads (status, get/list jobs) | 120 / min |
| Per key — writes (create, run, cancel) | 30 / min |
| Per workspace (all keys) | 600 / min |
| Failed authentication per client IP | 20 / min |

On `429`, wait `Retry-After` seconds. The provided workflows retry 429/502/503/504 themselves (bounded). In your own workflows, do not use a blanket **Retry On Fail** because it would also retry 401/403/404/409/422, which will not succeed on retry.

## 7. Retries & idempotency

n8n may retry a request. For `POST /sync-jobs`, always send the same `Idempotency-Key` for the same logical request (for example, `n8n-{{ $execution.id }}-create`). Retries return the original job; keys are scoped to the workspace.

Cancel is naturally idempotent.

## 8. Audit

- Every request creates one structured server log line (`event: n8n_api`, request ID, key ID, workspace, method, route, status, error code, duration). Never log the Authorization header, secrets, or bodies.
- State changes (job queued/cancelled, key created/revoked) are also written to the workspace activity log with the request ID and key ID.

## 9. n8n workflows

Credential setup (once): n8n → **Credentials → New → Header Auth**. Name: `Authorization`. Value: `Bearer pis_live_…` (your secret). Call it **Product Image Sync API**. The workflow files reference this credential by name only; they contain no secret.

### Production — `docs/n8n/product-image-sync-production.workflow.json`

"Product Image Sync — Production" imports as a new, **inactive** workflow. The file has no workflow ID, so it cannot overwrite another workflow.

```text
Manual Trigger ┐
Schedule Trigger┴→ Config → Health → Store Status → Ready? ─no→ Not Ready
  → Create Sync Job (dry_run:false, Idempotency-Key n8n-<execution>-create)
  → Start Worker (POST /sync-jobs/{jobId}/run, X-Request-ID n8n-<execution>-run)
  → Poll Job → Job Finished? ─no→ Poll Limit Reached? ─no→ Wait Before Next Poll → Poll Job
                                                   └yes→ Stop: Poll Timeout
               └yes→ Build Summary → Job Result: completed / completed_with_errors → Sync Completed
                                                cancelled → Stop: Job Cancelled
                                                failed    → Stop: Job Failed
Any API error → API Error Type → Stop: API Auth Failure (401/403) | Store Not Found (404)
                | Job Creation Conflict (409/422 on create) | Worker Start Failure | API Error
```

- **Config**: `baseUrl` (**DEVELOPMENT ONLY** — the ngrok URL; replace before activating), `storeId`, `triggerSource` (`scheduled` when the Schedule Trigger fired, otherwise `n8n`), `dryRun=false`, `maxRetries=3`, `pollIntervalSeconds=30`, `maxPolls=240`, `maxPollMinutes=120`.
- **Manual Trigger**: for testing.
- **Schedule Trigger**: conservative default once a day at **02:00 Asia/Kolkata** (workflow timezone setting). Change it in the node before activating.
- **Retries**: every call retries 429/502/503/504 and network errors at most 3 times, waiting `Retry-After` (otherwise 2/4/8 s; 1–60 s). 401/403/404/409/422 are never retried. Create retries reuse the same `Idempotency-Key`, so a retry never creates a second job.
- **Polling**: `GET /sync-jobs/{jobId}` every 30 s (or `Retry-After`, 5–300 s) until `completed`, `completed_with_errors`, `failed`, or `cancelled`; transient poll errors just poll again. Bounded by 240 polls / 120 minutes → **Stop: Poll Timeout**. The job keeps running on the server; it is **not** cancelled.
- **Summary**: `store_id, job_id, status, trigger_source, dry_run, progress, counts, review_items, failed_items, started_at, completed_at, cancelled_at, error, polls`.
- Error messages contain HTTP status, safe error code, safe message, and `request_id` only.
- Only one job per store can be active. A schedule that fires while a job runs stops at **Job Creation Conflict** with the active job ID.

### Dry run test — `docs/n8n/product-image-sync-dry-run-test.workflow.json`

"Product Image Sync — Dry Run Test" uses the same flow with Manual Trigger only and `dry_run=true` (scan + match + metadata; no download, no upload). Use it to prove:

`n8n → API → job → worker → Drive scan → result`

without changing anything.

### Real integration validation — 2026-10-02

Prompt 13 was validated against the real n8n → API → sync job → worker → Google Drive scan path using `dry_run=true`.

- Job ID: `fab524f5-05d7-46eb-9352-c142777d0333`
- Terminal status: `completed`
- Dry run: `true`
- Products processed: `0`
- Images uploaded: `0`
- Failed items: `0`
- Live Prompt 13 harness: `2/2` passed
- Drive downloads: `0`
- Drive writes: `0`
- Shopify mutations: `0`
- `sync_images` mutations: `0`
- Regression suite: `492/492` tests passed; typecheck, lint, and production build passed

The real dry run exposed an RPC edge case where nullable `sync_job_finish` / `sync_item_update` parameters were omitted. The repository now sends explicit nulls, and `tests/jobs-repository-null-rpc.test.ts` prevents regression.

The older "Product Image Sync — API Test" workflow (`product-image-sync-api-test.workflow.json`, dry-run job → read → cancel) stays a separate API test.

Both production workflow files are generated by `python3 scripts/generate-n8n-workflows.py` and checked by `node scripts/check-n8n-workflows.mjs` for structure, credential references, secrets, expression syntax, and simulated runs of every branch.

Equivalent curl:

```bash
curl -s https://YOUR-APP-DOMAIN/api/n8n/v1/stores/$STORE_ID/status \
  -H "Authorization: Bearer $PIS_API_SECRET"

curl -s -X POST https://YOUR-APP-DOMAIN/api/n8n/v1/sync-jobs \
  -H "Authorization: Bearer $PIS_API_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-$(date +%s)" \
  -d "{\"store_id\":\"$STORE_ID\",\"trigger_source\":\"n8n\",\"dry_run\":true}"

curl -s -X POST https://YOUR-APP-DOMAIN/api/n8n/v1/sync-jobs/$JOB_ID/run \
  -H "Authorization: Bearer $PIS_API_SECRET"
```

## 10. Callbacks

There is **no** generic webhook. Progress is pulled with `GET /sync-jobs/:jobId`; the worker is started with the dedicated `POST /sync-jobs/:jobId/run`. Any future endpoint gets the same key auth + scope and is specific — never an endpoint that accepts arbitrary commands.
