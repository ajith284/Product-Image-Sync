# Security review — Prompt 14 (security + failure testing)

Date: 2026-10-02 · Branch: `prompt14-security-failure-testing` · Base: `a568874` (Prompt 13)

All testing used mocks, fakes and a **local** Postgres 16. No live Shopify upload, no
production sync job, no Google write, no n8n workflow execution, and no change to the
linked Supabase project (`xkzccfxrixpyozfhamdh`). The legacy workflow
"Shopify image Uploaded automation" (`qrV4vJjAa2Jbbgmp`) and "Product Image Sync — API
Test" (`5uS72dDfrLYKZd1j`) were not touched.

## 1. Scope

| Area | What was reviewed / tested |
|---|---|
| Database | RLS on every table, grants, SECURITY DEFINER functions, cross-workspace isolation, sync-job lease races |
| Shopify | OAuth (callback HMAC, state, session/shop binding), store actions, webhooks (HMAC, size, idempotency, compliance topics) |
| Google | OAuth (PKCE, state, ID token), store actions, Drive access errors during sync |
| API keys | creation, listing, revocation, store restriction, secret handling |
| n8n API | auth, scopes, isolation, signing / replay, rate limits / `X-Forwarded-For`, body limits, `/run` |
| Worker | DB outages, launch failures, leases, crashes, cancellation, Drive / Shopify failures, retries, duplicates |
| n8n workflows | stuck-job recovery, structure / secret checks, simulated runs |
| Platform | security headers / CSP, secret scan, Supabase advisor classification |

## 2. Baseline (Prompt 14A, `a568874`)

`npm test` 492/492 · typecheck, lint, build pass · n8n checker 91/91 · SQL 272/272.

## 3. Database (Prompt 14B)

- **Schema-wide invariants** (`supabase/tests/security_invariants_test.sql`, 33 checks): RLS on
  every table in `public` / `internal` / `private`; `internal` has no policies and no grants to
  `anon` / `authenticated`; every SECURITY DEFINER function (59) pins `search_path=''`; EXECUTE
  for `authenticated` is exactly `create_workspace` + the 5 RLS helpers; nothing is executable by
  `anon` or `PUBLIC`; all n8n / sync / OAuth / API-key / webhook RPCs are `service_role` only;
  table and column grants for `authenticated` match explicit allow-lists; a new unlisted public
  function fails the test. Verified to catch injected violations.
- **Cross-workspace** (`cross_workspace_test.sql`, 24): category roots, `sync_errors`, and the
  Prompt 13 `sync_items` fields are invisible to other workspaces, non-members, `anon` and removed
  members; members cannot write them; server RPCs refuse cross-workspace / cross-job writes.
- **Claim races** (`concurrency/sync_job_claim_race_test.sql`, 18, real concurrent sessions via
  `dblink`, local only, self-cleaning): one winner for simultaneous claims, stale-lease reclaims
  and `/run` calls; losers cannot report progress, write items or finish.
- **Result:** no defect.

### Supabase security advisor (live baseline, recorded by the user — not re-run here)

| Finding | Classification |
|---|---|
| `internal.api_keys`, `api_rate_limits`, `api_request_nonces`, `integration_secrets`, `oauth_states`, `webhook_events` — RLS enabled, no policy | **Intentional (INFO).** Server-only tables; `internal` is not exposed and has no grants. |
| `public.create_workspace` SECURITY DEFINER executable by `authenticated` | **Intentional (WARN).** Creates the caller's workspace + owner row atomically; covered by the invariant test. |
| Auth leaked-password protection disabled | **Manual action** (§12). |

## 4. Shopify OAuth / store actions (14C)

Already strong and covered: callback HMAC (timing-safe), timestamp window, shop-domain checks,
hashed one-time state with expiry, binding to the signed-in user and to the shop, scope downgrade
rejected, encrypted expiring tokens with optimistic-lock refresh. New tests
(`tests/store-actions-security.test.ts`): owner/admin allowed; member refused before any DB or
Shopify call; signed-out / expired session → login; other workspace and forged store IDs → the same
"not found"; every store lookup is filtered by **id and current workspace**; failures never return
tokens, DB errors or the client secret. Mutation-tested. **No defect.**

## 5. Google OAuth / store actions (14C)

Already covered: PKCE, one-time state, user binding, ID-token audience / issuer / expiry checks,
encryption bound to the store, revoke rules, GET-only Drive client, no open redirect. Gaps filled:
admin, signed-out verify / disconnect, member on verify and folder actions, foreign stores on folder
actions, workspace scoping, no leaks. **No defect.**

## 6. API keys (14C)

`tests/api-keys-actions.test.ts`: only SHA-256 hashes reach the DB; the token is shown once;
listing never returns token or hash (even if the RPC returned extra columns); members refused
before the DB (and by the DB re-check); forged workspace fields ignored; another workspace's store
can't be used for a restricted key; revoked keys get `401` immediately through the real n8n route;
revoking twice is safe; errors never leak SQL text or config. **No defect.**
Observation (accepted): revoke is scoped to "manager of the key's workspace", not to the workspace
currently selected in the UI — the user has authority over that key either way.

## 7. Webhook body size (14C.1)

Shopify documents no maximum payload. Limit **1 MiB** (`MAX_WEBHOOK_BODY_BYTES`): app/uninstalled
is a few KB and the compliance payloads are IDs. Declared `Content-Length` over the limit → `413`
without reading; the stream itself is counted, so missing / chunked / understated lengths are
bounded too (memory ≤ limit + one chunk); malformed length or broken upload → `400`; checked before
the HMAC and before credentials are loaded. HMAC now runs on the exact raw bytes. Implemented in
`lib/http/limited-body.ts` (shared with the n8n API).

## 8. n8n API (14D) — `tests/n8n-hardening.test.ts`

| Item | Result |
|---|---|
| Auth (missing / malformed / random / revoked keys, wrong scope, other workspace, restricted key on another store, malformed IDs, sanitized 500s) | Correct, now tested. |
| **`X-Forwarded-For` throttle bypass** | **Confirmed and fixed.** The failed-auth limit used the *first* `X-Forwarded-For` entry. ngrok (the current deployment) appends the real client IP and keeps caller-supplied entries, so rotating a spoofed first entry reset the limit on every request. Now the right-most entry (`N8N_TRUSTED_PROXY_HOPS`, default 1) is used; `X-Real-IP` is ignored; values are validated as IPs. Proxy assumption documented in `lib/n8n/handler.ts` and `docs/n8n-api.md`. |
| **Unbounded request body** | **Confirmed and fixed.** `request.text()` ran before the 16 KB check, so a missing / understated `Content-Length` let an unauthenticated caller make the server buffer a large body. Now bounded while streaming (`413` / `400`), before authentication. |
| Signing / replay (valid, invalid, missing-when-required, stale / future / malformed timestamps, changed body / path / query / method, reused request ID, exact replay, per-key nonces) | Correct, now tested. A blank signature header counts as unsigned (accepted only while signing is optional). |
| `/run` (signed, replayed, rate-limited, wrong workspace / job / store, already_running, finished, reclaimed, sanitized errors, no internals in responses) | Correct, now tested. |
| Input safety (Content-Length / actual size, content type, invalid JSON, unknown fields) | Correct after the body fix. |

### Request-signing decision (14F)

**Bearer-only for the n8n workflows; signing remains optional** (`N8N_API_REQUIRE_SIGNATURE`).
Reasons: the signing key is SHA-256 of the API secret, so any holder of the token can also sign —
no protection against token theft; every write endpoint is already replay-safe (tested: create →
same job via Idempotency-Key, `/run` → `already_running`, cancel → `changed:false`); requiring
signatures would break the API Test workflow that must not be modified. n8n *can* sign (Crypto node
+ Crypto credential) for clients that want integrity beyond TLS. **Residual risk:** anyone who can
read full requests (e.g. a TLS-terminating proxy's inspector) holds the token anyway — mitigate with
store-restricted keys, prompt revocation and a production host without request inspection.

## 9. Worker failures and stale-job recovery (14E)

`tests/sync-worker-failures.test.ts` (22) adds: DB outage during progress / item / ledger writes
(→ `failed` / `INTERNAL_ERROR`, uploads kept); `finish()` failure (job stays `running`, lease
expires, reclaim completes **without re-uploading**); DB down from the start (nothing touched);
background launch crash / missing config (logged by class name only); failing logger; concurrent
workers (one wins); late worker with a lost lease; Drive file deleted / permission removed (that
image fails, job continues); Google disconnected mid-run (stops); Shopify product deleted (no
retries, other products continue); Shopify throttled forever (3 attempts, then stop); huge
`Retry-After` capped at 30 s; exhausted retryable images blocked; changed files re-uploaded; no
secrets or image bytes anywhere. Existing `tests/sync-worker.test.ts` already covers 0/1/many
matches, duplicates, cancellation, dry run, crash recovery and idempotent restart.

**Confirmed and fixed:**
1. **Root inaccessible poisoned the ledger.** `DRIVE_ROOT_INACCESSIBLE` (category root un-shared /
   trashed mid-run) marked every remaining image as a permanent failure, so they stayed blocked
   after access was restored. It is now a stop code: the job fails, nothing is poisoned, the next
   run uploads the rest.
2. **Logging could prevent finishing.** A throwing `console.error` skipped `finish()` (job left
   `running` until lease expiry) and escaped `after()` as an unhandled rejection. Logging is now
   wrapped in both the worker and the launcher.
3. **Stuck running job (confirmed in the generated workflow).** A dead worker left the job
   `running`; the next run got `409 SYNC_JOB_ALREADY_ACTIVE` and the production workflow stopped,
   every time. Now the production workflow calls `POST /sync-jobs/{active_job_id}/run` and polls that
   job: live lease → waits, stale lease → reclaimed, finished → nothing re-run; never a second job.
   The dry-run test workflow keeps stopping (it must never start a queued real sync). Verified by
   the workflow checker (105/105, incl. live / stale / finished / no-id / idempotency-conflict
   scenarios) and `supabase/tests/stale_job_recovery_test.sql` (8). Both workflows regenerated with
   the existing generator; still inactive, no secrets.

## 10. Shopify privacy webhooks (14F)

Shopify (privacy-law compliance docs, checked 2026-10-02): every distributed app must answer all
three topics with 2xx; `shop/redact` arrives 48 h after uninstall "so that you can erase data for
that store"; complete within 30 days. The app requests no customer scopes and stores no customer
data.

- `customers/data_request`, `customers/redact` → `200`, recorded only (nothing invented, nothing deleted).
- `shop/redact` → **implemented** (`supabase/migrations/20261002100000_shopify_shop_redact.sql`,
  `public.shopify_handle_shop_redact`, service-role only): deletes the shop's Shopify connection and
  tokens, OAuth states, product mappings and the Shopify media ledger (`sync_images`); nulls the
  Shopify fields of `sync_items` and removes Shopify candidates from job results. Keeps the
  merchant's Product Image Sync store, Google connection and job counts. Skips everything if the
  shop is connected again (reinstalled). Idempotent per webhook ID and per shop. Tests: 15 SQL + route
  tests. Consequence: after a redact, a later re-install starts without the duplicate ledger.
- **Not yet applied to the linked project** — see §12.

## 11. Security headers (14F)

Added to every route: `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src
'none'`, `Cross-Origin-Opener-Policy: same-origin`, and (production only)
`Strict-Transport-Security: max-age=31536000; includeSubDomains`. Kept: `X-Frame-Options: DENY`,
`nosniff`, `Referrer-Policy`, `Permissions-Policy`. **Deferred:** `script-src` / `style-src` need
per-request nonces from `proxy.ts` and dynamic rendering of every page (Next.js 16 CSP guide);
`form-action` would break the OAuth redirects. Tested in `tests/security-headers.test.ts`.

## 12. Manual actions

1. **Supabase Auth → enable leaked-password protection** (dashboard; not changed from here).
2. **Apply `20261002100000_shopify_shop_redact.sql`** to the linked project before relying on
   `shop/redact` (until then the webhook would answer `500` and Shopify retries for 4 hours).
3. Re-import the regenerated production workflow if the stale-job recovery is wanted in n8n
   (keep it inactive until `baseUrl` points at the production host).
4. In production behind more than one appending proxy, set `N8N_TRUSTED_PROXY_HOPS`.

## 13. Secret scan

Tracked and untracked files (excluding `node_modules`, build output): **no real secrets.** Hits
are fake test fixtures only (`tests/helpers/google-fakes.ts`, `tests/google-config.test.ts`,
`tests/google-download.test.ts`) and a pattern false positive in `.env.example` (all secret values
empty). Workflow JSON: no secrets, credential referenced by name only (checker). `.env.local` is
git-ignored and not tracked; `tmp-prompt*` harnesses are git-ignored.

## 14. Deferred / accepted risks

- Next.js proxy buffers up to 10 MB (`proxyClientMaxBodySize`) before route handlers run; the
  route limits above cap what is processed, not that buffer. Lower it or exclude the machine routes
  from the proxy matcher in a dedicated change.
- Full script/style CSP (nonce-based) — needs a frontend audit.
- Request signing optional (decision above).
- Per-file `PERMISSION_DENIED` from Drive is recorded as permanent; if access is later granted
  without the file changing, it stays blocked until the file is modified.
- If `/run` claims a job but the background launch itself throws, the job waits for the 15-min
  lease; the workflow's stale-job recovery then reclaims it.
- `lib/sync/jobs-repository.ts` (from `a568874`) starts with a UTF-8 BOM and has mis-encoded
  arrows in a comment — cosmetic, not changed here.

## 15. Final test results

| Check | Result |
|---|---|
| `npm test` | 691 / 691 (28 files) |
| `npm run typecheck` | pass |
| `npm run lint` | pass, 0 warnings |
| `npm run build` | pass |
| `node scripts/check-n8n-workflows.mjs` | 105 / 105 |
| Local SQL (12 suites) | 370 / 370 |

No live Shopify upload occurred · no production sync job ran · the linked Supabase project was not
mutated.
