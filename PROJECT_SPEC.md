# PROJECT_SPEC.md — Product Image Sync

Permanent source of truth. **Every task reads this file first.**

---

## 1. Product

Product Image Sync is a multi-tenant SaaS that automatically uploads Google Drive product images to **existing** Shopify products. It only adds media. It never creates, edits, publishes or deletes products.

Customers never use n8n directly. The app handles: login · multiple Shopify stores · Shopify connection · Google Drive connection · Drive folder selection · matching settings · sync history · errors · manual product mapping · store settings.

**Stack** (reuse what already exists): Next.js · React · TypeScript · Tailwind CSS · shadcn/ui · Supabase (DB + Auth) · Shopify Admin GraphQL API · Google Drive API · n8n

## 2. Fixed references

| Item | Value |
|---|---|
| Supabase project | `https://xkzccfxrixpyozfhamdh.supabase.co` (ref `xkzccfxrixpyozfhamdh`) |
| n8n master workflow | **Shopify image Uploaded automation** — ID `qrV4vJjAa2Jbbgmp` |

Legacy workflow reference only. **Do not modify, rename, delete, activate/deactivate, repurpose, execute, add/remove nodes, change credentials, or change triggers.** New Product Image Sync workflows stay separate.

## 3. Architecture

| One | Many |
|---|---|
| App, Supabase project, Shopify app (multi-merchant), master n8n workflow | Shopify store connections, Google Drive connections |

Each store has its own Shopify connection, Drive connection, root folder, settings, product mappings and sync history.

## 4. Shopify

**Connection flow:** Add Store → Connect Shopify → Shopify authorization → callback to Product Image Sync → encrypted server-side token storage → Shopify Connected.

- Users never paste access tokens.
- Access/refresh tokens stay server-side and encrypted. Never exposed to browser JS, frontend API responses, normal Supabase client access, activity logs, or n8n.
- Connection metadata is stored separately from encrypted credentials.
- Minimum scopes: `read_products`, `write_products`, `write_files` (add more only if a requirement demands it).
- Admin GraphQL API only. No deprecated REST product workflows.

### Product status
Sync works on products in **any** status (DRAFT, ACTIVE, ARCHIVED, UNLISTED, …) and preserves it. Never change status.

### Never modify
title · description · handle · URL · price · compare-at price · SKU · barcode · inventory · variants · options · vendor · product type · tags · status · publishing channels.

Only product images/media are managed. Default: **add new images only**. Never automatically delete existing Shopify images.

## 5. Google Drive

```
Sofa/                    ← root folder selected per store
├── SOF-001/             ← organization/product-code folder ONLY (not a SKU, never matched)
│   └── Milano/          ← product matching folder
│       ├── image-01.jpg   ✅ upload
│       ├── image-02.jpg   ✅ upload
│       └── OG/            ❌ ignored with all contents
│           └── OG-image.jpg
└── SOF-002/
    └── Roma/ …
```

### Image rules
- Allowed: `jpg` `jpeg` `png` `webp`. Everything else ignored.
- Only direct image files inside the product folder. No recursion into subfolders.
- Ignore any folder named `OG` and every file inside it.
- Natural sort (`image-2` before `image-10`).

### Connection
Connect Google Drive → authorize → select root folder → save root folder ID → discover product folders.
- Each store may use a different Google account/folder.
- Tokens (esp. refresh tokens) encrypted, server-side only, never given to n8n.
- Use the minimum OAuth scope that supports folder selection, listing, download and background sync; check current Google docs and report whether it needs Google verification.

## 6. Matching

1. **Manual mapping** (`product_mappings`) always wins.
2. Otherwise search Shopify products by Drive product folder name. A product matches if its normalized title **contains** the normalized folder name (`Milano` → "Milano 3 Seater Sofa").

Normalization: trim, collapse repeated spaces, case-insensitive. **SKU is never used.**

| Automatic matches | Result |
|---|---|
| 0 | `no_product_found` → Review Center |
| 1 | continue with upload |
| 2+ | `multiple_matches` → Review Center, **upload nothing** |

Never guess between multiple products.

## 7. Duplicate protection

Never re-upload the same unchanged image. Per image track: Drive file ID, filename, checksum (if available), modified time (if available), Shopify media ID, upload status.

Run 1 uploads 01–03 → run 2 (no changes) uploads nothing → image-04 added → run 3 uploads only 04.

## 8. n8n (internal only)

Implemented flow (Prompt 13, `docs/n8n/product-image-sync-production.workflow.json`):
```
Manual / Schedule trigger → Config → Health → Store Status → Ready?
→ POST /sync-jobs (dry_run:false, Idempotency-Key) → POST /sync-jobs/{jobId}/run (server-side worker)
→ poll GET /sync-jobs/{jobId} (bounded) → completed / cancelled / failed → summary
```
- n8n works with IDs only: `store_id`, `job_id`. The worker (not n8n) discovers category roots → code folders → product folders → images.
- n8n authenticates ONLY with the Product Image Sync API key (Header Auth credential "Product Image Sync API", `docs/n8n-api.md`).
- n8n must **not** store or receive: Shopify access/refresh tokens, Google access/refresh tokens, Supabase credentials.
- The backend loads credentials; one job = one worker (lease); the workflow never cancels jobs by itself.
- Existing workflows "Shopify image Uploaded automation" (`qrV4vJjAa2Jbbgmp`) and "Product Image Sync — API Test" (`5uS72dDfrLYKZd1j`) are separate and never modified.

## 9. Supabase

Target entities (inspect first; reuse equivalents, don't duplicate):
profiles · workspaces · workspace_members · stores · shopify_connections · integration_secrets · google_drive_connections · store_settings · oauth_states · product_mappings · sync_jobs · sync_items · sync_images · sync_errors · activity_logs

## 10. Security

- RLS on every table. Users access only workspaces they belong to; no cross-customer visibility.
- Every server-side store operation validates: authenticated user → workspace membership → permission → store belongs to workspace.
- Secrets never reach normal frontend users. No `NEXT_PUBLIC_*` (browser) env vars for secrets. Service-role key never in frontend code.
- Authorization never relies on user-editable metadata.
- Never log secrets. Never return secrets in API responses.

## 11. Customer UI

Pages: Dashboard · Stores · Add Store · Store Details · Drive Mapping · Sync Jobs · Review Center · Activity · Settings

Users never need to understand OAuth tokens, GraphQL, webhooks, n8n nodes or API credentials. Friendly messages — e.g. `401 Unauthorized` → "Shopify needs to be reconnected."

### Review Center
Handles: No Product Found · Multiple Shopify Matches · Image Upload Failed. For multiple matches, never auto-select; the user picks the product, the choice is saved to `product_mappings` and used first on every future sync.

### Activity log (human-readable, no secrets)
"Started Royal Sofa sync" · "Matched Milano → Milano 3 Seater Sofa" · "Uploaded 3 images" · "Skipped image-01.jpg (already uploaded)" · "Ignored OG folder"

## 12. External API rule

Before implementing anything touching Shopify, Google, Supabase or n8n: check the **current official docs**. Don't copy old tutorials. Use current Shopify Admin GraphQL patterns.

## 13. Development rules (every task)

1. Read `PROJECT_SPEC.md` first.
2. Inspect the existing implementation before editing.
3. Implement only the requested phase.
4. Don't redesign unrelated code.
5. Don't duplicate existing working functionality.
6. Test the implementation.
7. Fix errors found during testing.
8. Stop after the requested phase.
9. Give a concise completion report.
10. List manual actions the user must perform.

**Never automatically continue to another phase.**

## 14. Current state (updated 2026-10-02)

### Phase log
- **Phase 0 — Audit:** repo and Supabase were empty; this spec created.
- **Phase 1 — Foundation (done):** Next.js 16.3 (App Router, Turbopack), React 19, TypeScript, Tailwind 4 (CSS-first config in `app/globals.css`), shadcn/ui (new-york, neutral), Lucide, `@supabase/ssr`. Root-level layout: `app/`, `components/{ui,layout,shared,auth}`, `lib/`, `lib/supabase/`, `hooks/`, `proxy.ts`, `public/`. Email/password auth (login, signup, email-link confirm, sign out). `proxy.ts` refreshes the session and guards routes; `app/(app)/layout.tsx` re-verifies with `getClaims()`. Shell: sidebar + header (renamed in Phase 3 to `components/layout/sidebar.tsx` / `header.tsx`), placeholder pages: Dashboard, Stores, Add Store, Drive Mapping, Sync Jobs, Review Center, Activity, Settings. `.env.example` lists variable names only (public vars). `lib/env.server.ts` (`server-only`) is the place for future secrets. Security headers in `next.config.ts`. No database objects created. Verified: fresh `npm install`, `npm run typecheck`, `npm run build`, `npm run dev`.
- **Phase 2 (Prompt 1) — Database + RLS (done):** migrations `supabase/migrations/20260929155910_initial_schema.sql` and `20260929155952_rls_and_grants.sql` applied to `xkzccfxrixpyozfhamdh`. 48/48 RLS/constraint tests pass (`supabase/tests/rls_test.sql`, self-rolling-back). Typed clients via `lib/supabase/database.types.ts`; DB enum values in `lib/supabase/constants.ts`.
- **Phase 3 (Prompt 2) — Auth, onboarding, app shell (done):** migration `20260929162040_default_workspace_on_signup.sql` (sign-up trigger now creates profile + "My Workspace" + owner membership atomically). Sign-up collects full name. Workspace context resolved server-side (`lib/workspace.ts`: `requireWorkspace()` = session → membership; `hasPermission()` for role checks; selected workspace in httpOnly cookie `pis_workspace`, always re-validated against membership). `/onboarding` for users with no workspace. Real-data pages: Dashboard (stats), Stores (table/cards), Add Store wizard (creates store in `setup` status; no integrations), Store details `/stores/[id]` (scoped to current workspace), Settings (profile name, workspace name, members). Placeholders: Drive Mapping, Sync Jobs, Review, Activity. Expired sessions → `/login?reason=expired`. 49/49 DB tests pass.
- **Phase 4 (Prompt 3) — Shopify foundation (done):** `lib/shopify/{config,scopes,domain,client,oauth,types}.ts`, `docs/shopify-setup.md`, Vitest (`npm test`, 69 tests). Decisions (checked on shopify.dev 2026-09-30): standalone non-embedded app · authorization code grant · **expiring offline tokens** (`expiring=1`; 1 h access / 90-day refresh; mandatory for public apps created ≥ 2026-04-01) · public **unlisted** distribution · API version from `SHOPIFY_API_VERSION` (latest stable `2026-07`) · scopes exactly `read_products,write_products,write_files`. OAuth routes planned at `/api/shopify/auth` and `/api/shopify/callback` (not built). No DB changes.

### Database (Phase 2)
- **Schemas:** `public` (API-exposed, RLS on every table) · `private` (RLS helper functions; not exposed) · `internal` (server-only tables `integration_secrets`, `oauth_states`; not exposed, no USAGE for anon/authenticated, RLS on with no policies → service_role only).
- **Tables (public):** profiles, workspaces, workspace_members, stores, shopify_connections, google_drive_connections, store_settings, product_mappings, sync_jobs, sync_items, sync_images, sync_errors, activity_logs. Enum-like columns are `text` + CHECK constraints (values mirrored in `lib/supabase/constants.ts`).
- **Tenant integrity:** composite FKs force child rows to match their parent's store/workspace (sync_items→sync_jobs, sync_images/sync_errors→sync_items/jobs, activity_logs/oauth_states→stores).
- **Access:** membership via `workspace_members` only (never user_metadata). owner = all; admin = stores, store settings, add/remove `member`s; member = read + manual product mappings. Nobody can create/assign `owner` or change their own role via the API. Connection metadata, sync history and activity are read-only for users (server writes).
- **Workspace creation:** `rpc('create_workspace', { p_name, p_slug })` — SECURITY DEFINER, creates workspace + caller's owner row atomically. Advisor warns (0029); intentional.
- **Automatic rows:** profile on sign-up (trigger on auth.users); store_settings with defaults on store insert; secrets deleted when their connection is deleted.
- **Column grants:** users may only write specific columns (e.g. stores: insert workspace_id/name/shopify_domain, update name; `status` is server-managed).
- **Default privileges changed:** new tables/functions created in `public` are NOT granted to anon/authenticated automatically. Every future migration must add explicit GRANTs + RLS policies.
- **Secrets:** tokens are encrypted by the app (server-side key, AES-GCM planned) before insert into `internal.integration_secrets`; server reads/writes with the secret key only. Never expose `internal` in API settings.
- **After every migration:** regenerate `lib/supabase/database.types.ts`, rerun `supabase/tests/rls_test.sql`, run security advisors.

### Open items for the Shopify OAuth phase (Prompt 4)
- Add `refresh_token_expires_at` to `internal.integration_secrets` (expiring tokens have a 90-day refresh token).
- Decide one active connection per shop across ALL workspaces (unique `shopify_connections.shop_domain` where connected): re-authorizing the same shop from another workspace rotates/retires the first workspace's tokens.
- Implement token encryption (AES-256-GCM with `SHOPIFY_TOKEN_ENCRYPTION_KEY`) and a refresh-before-use helper; serialize refreshes per shop (rotation invalidates the old refresh token).

### Conventions established in Phase 1
- Server Supabase client: `@/lib/supabase/server` (per request, user-scoped, RLS applies). Browser client: `@/lib/supabase/client`.
- Auth check: `requireUser()` / `getSessionUser()` from `@/lib/auth`. Never trust `getSession()` on the server.
- Redirects from `?next=` go through `safeNextPath()`.
- Customer-facing errors go through friendly mappers (see `lib/auth-errors.ts`).
- Nav items live in `lib/navigation.ts`.
- Next.js 16: `proxy.ts` replaces `middleware.ts`. Read `node_modules/next/dist/docs/` for current APIs.

### Conventions established in Phase 3
- Every protected page/action starts with `requireWorkspace()`; writes use `ctx.workspace.workspaceId` from the server context, never IDs from forms/URLs.
- UI permission map in `lib/permissions.ts` mirrors RLS (owner/admin manage stores & workspace; member read + mappings).
- Data access helpers in `lib/data/*` (server-only, RLS-scoped, session errors → login redirect).
- Friendly error mapping in `lib/errors.ts`; never show raw DB/JWT errors.
- Components: `components/layout/{sidebar,header,user-menu,workspace-switcher}`, `components/dashboard/stat-card`, `components/shared/{empty-state,page-header}`, `components/stores/{store-table,store-card,store-status-badge,setup-stepper,add-store-wizard}`, `components/settings/name-form`.

### Conventions established in Phase 4
- All Shopify server code lives in `lib/shopify/*` and imports `server-only`, except `domain.ts` (pure, shared with the Add Store form).
- Read config only via `getShopifyConfig()` inside handlers (throws `ShopifyConfigError` naming missing vars); never at module load.
- Validate shop domains with `normalizeShopDomain()` (user input) / `isValidShopDomain()` (Shopify-provided values).
- Show `ShopifyApiError.userMessage` to customers, never raw API errors.
- Unit tests live in `tests/*.test.ts` (Vitest, `server-only` stubbed).

### Environment
- **Local repo** `C:\Users\ajith\Desktop\shopify-image-uploaded-automation` — branch `main`, remote `origin` = GitHub.
- **GitHub** `ajith284/product-image-sync` (public).
- **Supabase** `xkzccfxrixpyozfhamdh` — Prompt 13 migration `20261001220000_sync_worker.sql` applied; migration history repaired for the preceding n8n/image-sync migrations. No storage buckets.
- **Supabase Data API (confirmed 2026-09-29):** exposed schemas = `public`, `graphql_public` only. `internal` and `private` are NOT exposed. Automatic table exposure is disabled.
- **`.mcp.json`** points at `xkzccfxrixpyozfhamdh` (fixed).

### Prompt 13 — Full sync worker + n8n production workflow (done)
- **Drive hierarchy:** Category Root → Code Folder → Product Name Folder → Images. **Only the Product Name Folder is matched to Shopify** (never the code folder, category folder, SKU or filename).
- **Worker:** `lib/sync/worker.ts` `runSyncJob()` = claim → scan each category root (`scanCategoryRoots`) → `sync_items` per product folder → 0 / 2+ matches = review (no download/upload) → single match: duplicate check → `downloadDriveImage()` → `uploadProductImage()` → progress → completed / completed_with_errors / cancelled / failed. Deps in `lib/sync/runtime.ts`, DB access `lib/sync/jobs-repository.ts`, background start `lib/sync/launch.ts` (`after()`).
- **Migration** `20261001220000_sync_worker.sql`: `sync_jobs.worker_id / claimed_at / heartbeat_at / result`; `sync_items.category_root_id / code_folder_id / code_folder_name / match_candidates / images_skipped / images_failed` + unique (job, product folder); functions `n8n_start_sync_job`, `sync_job_claim`, `sync_job_heartbeat`, `sync_job_finish`, `sync_item_record`, `sync_item_update` (service role only; each re-checks workspace → job → worker lease). Tests: `supabase/tests/sync_worker_test.sql`.
- **API:** `POST /api/n8n/v1/sync-jobs/{jobId}/run` (scope `n8n:sync`): 202 claimed/reclaimed, 200 already_running/finished. No body accepted.
- **Lifecycle:** `queued → running → completed | completed_with_errors | failed | cancelled`. Lease 15 min; stale lease → re-claim (crash recovery); restart is idempotent.
- **Dry run:** scan + match + metadata only; no download, upload, Drive/Shopify mutation or `sync_images` write; `result.plan` = would_upload / skipped / blocked / review / failed.
- **Prompt 13 real validation (2026-10-02):** real n8n → API → worker dry run `fab524f5-05d7-46eb-9352-c142777d0333` completed with `dry_run=true`, 0 products processed, 0 images uploaded and 0 failed items. Live harness passed 2/2 and verified 0 Drive downloads, 0 Drive writes, 0 Shopify mutations and 0 `sync_images` mutations. Regression suite: 492/492 tests passed; typecheck, lint and production build passed. Nullable `sync_job_finish` / `sync_item_update` RPC arguments now send explicit nulls and are covered by `tests/jobs-repository-null-rpc.test.ts`.
- **Errors:** temporary errors retried ×3 (Retry-After); permanent file errors fail that image only; Shopify needs reconnect or Google unavailable → job `failed`, completed work kept. Cancellation checked before every root, product, image, download, upload.
- **n8n:** production workflow (Manual + Schedule 02:00 Asia/Kolkata, inactive on import) and a manual-only dry-run test workflow, generated by `scripts/generate-n8n-workflows.py`, validated by `scripts/check-n8n-workflows.mjs`. `baseUrl` (ngrok) is DEVELOPMENT ONLY.

### Not built yet
Member invites, password reset. (Shopify OAuth, Google Drive OAuth, the n8n API and the sync worker are built — see the phase entries above and `docs/`.)
