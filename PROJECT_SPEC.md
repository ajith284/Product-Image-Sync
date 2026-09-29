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

Reuse or safely update this workflow. Never create one workflow per store, and don't create duplicates.

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

Target flow:
```
Schedule / Manual trigger
→ get connected stores → loop stores
→ backend discovers Drive product folders → loop folders
→ backend processes each folder → save result
→ continue even if one item or store fails
```
- n8n works with IDs only: `store_id`, `drive_product_folder_id`.
- n8n knows only the backend URL, an internal shared secret (`INTERNAL_SYNC_SECRET`) and safe IDs.
- n8n must **not** store: Shopify access/refresh tokens, Google access/refresh tokens, Supabase service-role credentials.
- n8n calls secure application backend endpoints; the backend loads credentials.

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

## 14. Current state (updated 2026-09-29)

### Phase log
- **Phase 0 — Audit:** repo and Supabase were empty; this spec created.
- **Phase 1 — Foundation (done):** Next.js 16.3 (App Router, Turbopack), React 19, TypeScript, Tailwind 4 (CSS-first config in `app/globals.css`), shadcn/ui (new-york, neutral), Lucide, `@supabase/ssr`. Root-level layout: `app/`, `components/{ui,layout,shared,auth}`, `lib/`, `lib/supabase/`, `hooks/`, `proxy.ts`, `public/`. Email/password auth (login, signup, email-link confirm, sign out). `proxy.ts` refreshes the session and guards routes; `app/(app)/layout.tsx` re-verifies with `getClaims()`. Shell: sidebar (`components/layout/app-sidebar.tsx`), header (`components/layout/app-header.tsx`), placeholder pages: Dashboard, Stores, Add Store, Drive Mapping, Sync Jobs, Review Center, Activity, Settings. `.env.example` lists variable names only (public vars). `lib/env.server.ts` (`server-only`) is the place for future secrets. Security headers in `next.config.ts`. No database objects created. Verified: fresh `npm install`, `npm run typecheck`, `npm run build`, `npm run dev`.

### Conventions established in Phase 1
- Server Supabase client: `@/lib/supabase/server` (per request, user-scoped, RLS applies). Browser client: `@/lib/supabase/client`.
- Auth check: `requireUser()` / `getSessionUser()` from `@/lib/auth`. Never trust `getSession()` on the server.
- Redirects from `?next=` go through `safeNextPath()`.
- Customer-facing errors go through friendly mappers (see `lib/auth-errors.ts`).
- Nav items live in `lib/navigation.ts`.
- Next.js 16: `proxy.ts` replaces `middleware.ts`. Read `node_modules/next/dist/docs/` for current APIs.

### Environment
- **Local repo** `C:\Users\ajith\Desktop\shopify-image-uploaded-automation` — branch `Clone`, no commits, no remote.
- **GitHub** `ajith284/product-image-sync` — public, empty, not yet linked as `origin`.
- **Supabase** `xkzccfxrixpyozfhamdh` — still empty (no tables, policies, functions, buckets). Extensions: pgcrypto, uuid-ossp, supabase_vault, pg_stat_statements.
- **`.mcp.json`** still points at a different Supabase project (`oabbngivgsckcfdaqhbp`) — fix before local DB work.

### Not built yet
Workspaces/membership schema + RLS, password reset, Store Details page, Shopify OAuth, Google Drive OAuth, token encryption, sync engine, n8n endpoints.
