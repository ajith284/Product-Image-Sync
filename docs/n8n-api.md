# Product Image Sync API for n8n (v1)

Machine-to-machine API between Product Image Sync and n8n (and future workers).
n8n gets **only** a Product Image Sync API key — never Shopify, Google or
Supabase credentials. Phase 8 only **queues** sync jobs; nothing is uploaded,
downloaded or changed yet.

```
Base URL:  https://YOUR-APP-DOMAIN/api/n8n/v1
           (dev: https://<your-ngrok-domain>/api/n8n/v1)
```

## 1. Create an API key

App → **Settings → API keys** (owners/admins) → name it (e.g. `n8n Production`),
choose **All stores** or **Only <store>**, pick permissions, optional expiry →
**Create API key**. You see two values **once**:

| Value | Format | Use |
|---|---|---|
| Secret | `pis_live_<12 chars>_<43 chars>` | `Authorization: Bearer <secret>` on every request |
| Signing key | 64 hex chars | Only if you sign requests (section 4) |

The server stores only `SHA-256(secret)`. Lost secret → revoke the key, create a new one.
Revocation takes effect on the next request.

### Scopes

| Scope | Allows |
|---|---|
| `n8n:read` | `GET /stores/:storeId/status` |
| `n8n:sync` | `POST /sync-jobs` (queue a job) |
| `n8n:jobs` | `GET /sync-jobs`, `GET /sync-jobs/:jobId`, `POST /sync-jobs/:jobId/cancel` |

Authorization is resolved **server-side from the key**: key → workspace →
optional store restriction → requested store. A `workspace_id` (or any unknown
field) in a request body is rejected.

## 2. Headers

| Header | Required | Notes |
|---|---|---|
| `Authorization: Bearer <secret>` | yes (except `/health`) | Browser cookies are ignored. |
| `Content-Type: application/json` | for bodies | Max body 16 KB. |
| `Idempotency-Key` | **yes** for `POST /sync-jobs` | 1–200 chars `A-Z a-z 0-9 . _ : -`. In n8n: `n8n-{{ $execution.id }}-create`. |
| `X-Request-ID` | optional (required when signing) | 8–100 chars `A-Z a-z 0-9 . _ : -`. Echoed back; generated if missing. |
| `X-PIS-Timestamp`, `X-PIS-Signature` | optional | Request signing, section 4. |

Every response has `X-Request-ID` and `Cache-Control: no-store`.

## 3. Endpoints

### `GET /health` — public
```json
{ "ok": true, "service": "product-image-sync", "version": "v1" }
```
Decision: **public** so n8n/uptime checks work without a key. It is static: no
database access, no store/workspace data, nothing to probe.

### `GET /stores/:storeId/status` — `n8n:read`
```json
{
  "store_id": "7bb362f0-…",
  "store_name": "BrandSure",
  "shopify": { "connected": true, "status": "connected", "shop_domain": "psvft1-0d.myshopify.com", "last_verified_at": "…" },
  "google_drive": { "connected": true, "status": "connected", "root_folder_selected": true,
                    "root_folder_id": "1AbC…", "root_folder_name": "Sofa", "last_verified_at": "…" },
  "ready_for_sync": true
}
```

### `POST /sync-jobs` — `n8n:sync` (+ `Idempotency-Key`)
Queues a job. **Does not run a sync.**
```json
{ "store_id": "7bb362f0-…", "trigger_source": "n8n", "dry_run": false, "category": "Sofa", "folder_id": "1AbC…" }
```
`trigger_source`: `n8n` (default) | `scheduled` | `api`. `dry_run`, `category`, `folder_id` optional.
Checks: key, workspace, store, Shopify connected, Drive connected, root folder selected.

- `201` new job · `200` + `Idempotent-Replayed: true` for a retry with the same key and body
- `409 IDEMPOTENCY_CONFLICT` same key, different body or store
- `409 SYNC_JOB_ALREADY_ACTIVE` (+ `active_job_id`) one queued/running job per store
- `409 SHOPIFY_NOT_CONNECTED | GOOGLE_DRIVE_NOT_CONNECTED | GOOGLE_DRIVE_ROOT_NOT_SELECTED`

Job object (also returned by the endpoints below):
```json
{
  "job_id": "…", "store_id": "…", "status": "queued", "trigger_source": "n8n", "dry_run": false,
  "options": { "category": "Sofa" }, "cancel_requested": false,
  "progress": { "total": 0, "processed": 0, "uploaded": 0, "skipped": 0, "review": 0, "failed": 0 },
  "counts": { "products_processed": 0, "products_synced": 0, "images_uploaded": 0, "warnings": 0, "errors": 0 },
  "error": null, "created_at": "…", "started_at": null, "completed_at": null, "cancelled_at": null
}
```
Statuses: `queued`, `running`, `completed`, `completed_with_errors`, `failed`, `cancelled`.

### `GET /sync-jobs/:jobId` — `n8n:jobs`

### `GET /sync-jobs?store_id=&status=&limit=&cursor=` — `n8n:jobs`
Newest first. `limit` 1–100 (default 20). Response `{ "data": [jobs], "next_cursor": "…" | null }`;
pass `cursor=<next_cursor>` for the next page.

### `POST /sync-jobs/:jobId/cancel` — `n8n:jobs`
`queued` → `cancelled`; `running` → `cancel_requested: true` (the future worker
stops). Cancelling again → `200` with `"changed": false`. Finished jobs →
`409 JOB_NOT_CANCELLABLE`.

## 4. Optional request signing (HMAC-SHA256)

Signing proves the body/path weren't altered and blocks replays. Unsigned
requests are accepted unless the server sets `N8N_API_REQUIRE_SIGNATURE=true`.

Headers: `X-PIS-Timestamp` (unix seconds, ±300 s), `X-Request-ID` (unique per
request — used as the nonce, remembered 10 min), `X-PIS-Signature`.

```
canonical = "v1" + "\n" +
            X-PIS-Timestamp + "\n" +
            HTTP_METHOD (uppercase) + "\n" +
            path + query            (e.g. /api/n8n/v1/sync-jobs?limit=20) + "\n" +
            hex(SHA-256(raw body))  (empty body → e3b0c442…b855) + "\n" +
            X-Request-ID

X-PIS-Signature = "v1=" + hex(HMAC-SHA256(key = <signing key>, message = canonical))
```

The signing key is the 64-hex value shown at creation (= `SHA-256(secret)`).
Still send `Authorization: Bearer <secret>`. n8n: a **Crypto** node (Hash SHA256
of the body; Hmac SHA256 with the signing key) or a Code node with `crypto`.

Errors: `REQUEST_EXPIRED` (timestamp), `INVALID_SIGNATURE`, `REPLAYED_REQUEST` (all `401`).

## 5. Errors

```json
{ "error": { "code": "STORE_NOT_FOUND", "message": "The requested store was not found.", "request_id": "req_…" } }
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

No stack traces, database errors or credentials are ever returned.

## 6. Rate limits (fixed 60-second windows)

| Bucket | Limit |
|---|---|
| Per key — reads (status, get/list jobs) | 120 / min |
| Per key — writes (create, cancel) | 30 / min |
| Per workspace (all keys) | 600 / min |
| Failed authentication per client IP | 20 / min |

On `429` wait `Retry-After` seconds. In n8n enable **Retry On Fail** on HTTP nodes.

## 7. Retries & idempotency

n8n may retry a request. For `POST /sync-jobs` always send the same
`Idempotency-Key` for the same logical request (e.g. `n8n-{{ $execution.id }}-create`):
retries return the original job; keys are scoped to your workspace.
Cancel is naturally idempotent.

## 8. Audit

- Every request: one structured server log line (`event: n8n_api`, request id,
  key id, workspace, method, route, status, error code, duration). Never the
  Authorization header, secrets or bodies.
- State changes (job queued / cancelled, key created / revoked) are also written
  to the workspace activity log with the request id and key id.

## 9. Example n8n setup

1. n8n → **Credentials → New → Header Auth**: Name `Authorization`, Value
   `Bearer pis_live_…` (your secret). Call it "Product Image Sync API".
2. Import `docs/n8n/product-image-sync-api-test.workflow.json` (Workflows → Import from File).
   It only checks health, store status, queues a **dry-run** job and reads it back.
3. In **Config** set `baseUrl` and `storeId`; select the credential on nodes 2–4; run.

Equivalent curl:
```bash
curl -s https://YOUR-APP-DOMAIN/api/n8n/v1/stores/$STORE_ID/status \
  -H "Authorization: Bearer $PIS_API_SECRET"

curl -s -X POST https://YOUR-APP-DOMAIN/api/n8n/v1/sync-jobs \
  -H "Authorization: Bearer $PIS_API_SECRET" -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-$(date +%s)" \
  -d "{\"store_id\":\"$STORE_ID\",\"trigger_source\":\"n8n\",\"dry_run\":true}"
```

## 10. Future callbacks (not built)

There is **no** generic webhook. When the worker needs to report progress, add
specific endpoints under this namespace with the same key auth + scope
(e.g. `POST /sync-jobs/:jobId/progress`, scope `n8n:jobs`, signed requests
required), never an endpoint that accepts arbitrary commands.
