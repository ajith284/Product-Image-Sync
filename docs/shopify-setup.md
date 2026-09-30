# Shopify app setup

How to create and configure the Shopify app that Product Image Sync uses to add
images to merchants' existing products. **Never commit real secrets** — they go
only in `.env.local` (local) or your host's environment settings (production).

_Last checked against shopify.dev: 2026-09-30._

## How the connection works

| Decision | Choice | Why |
|---|---|---|
| App type | **Standalone (non-embedded)** | Merchants use our dashboard, not Shopify admin. |
| Auth flow | **Authorization code grant** | The documented flow for apps running outside Shopify admin. |
| Token type | **Expiring offline access token** (`expiring=1`) | Background syncs need app-level access. Required for public apps created on/after 2026-04-01. Access token: 1 hour. Refresh token: 90 days (rotates on every refresh). |
| Distribution | **Public, unlisted** | One app installed by many independent merchants. |
| API | **GraphQL Admin API**, version `SHOPIFY_API_VERSION` | REST product workflows are legacy. |
| Scopes | `read_products,write_products,write_files` | Minimum for attaching media to existing products. |

```
Store page → [Connect Shopify]                       (owner/admin only)
  server action: session → workspace → role → store in workspace
  → validate stored *.myshopify.com domain
  → block if the shop is already connected in another workspace
  → random state; SHA-256 hash saved in internal.oauth_states (10 min, one-time)
  → redirect https://{shop}/admin/oauth/authorize
Merchant approves in Shopify
  → GET /api/shopify/callback
     1. shop format, HMAC (client secret, constant-time), timestamp (≤ 5 min)
     2. consume state (unknown / reused / expired → rejected)
     3. same signed-in user + same shop as when it started
     4. ONLY THEN: POST /admin/oauth/access_token (expiring=1)
     5. granted scopes include all required scopes
     6. AES-256-GCM encrypt tokens → save connection + secrets atomically
     7. read-only verification (shop info + 1 product) → "Connected ✓"
```

Other flows: **Verify** (read-only check), **Reconnect** (same OAuth flow, updates
the existing connection and replaces credentials), **Disconnect** (best-effort
`appUninstall` on Shopify, then credentials deleted and connection marked
disconnected; history kept), **app/uninstalled webhook** (same cleanup,
idempotent).

## Checklist — Shopify Dev Dashboard

Replace `APP_URL` with your app's base URL:
- Local development: an **https tunnel** URL to your `npm run dev` server (e.g. Cloudflare Tunnel / ngrok). Shopify must reach the webhook URL over the internet; `http://localhost:3000` works for the OAuth redirect only.
- Production: `https://your-domain.com`

### 1. Create the app
- [ ] Dev Dashboard → **Create app** → **Start from Dev Dashboard** → name "Product Image Sync".
- [ ] Distribution: **Public**, **unlisted** (not listed in the App Store).

### 2. App URL (app version settings)
- [ ] **App URL**: `APP_URL/stores`
- [ ] **Embedded in Shopify admin**: off

### 3. Allowed redirect URL(s)
- [ ] `APP_URL/api/shopify/callback` — must match `SHOPIFY_APP_URL` + `/api/shopify/callback` exactly.
- [ ] If you also test on plain localhost: `http://localhost:3000/api/shopify/callback`

### 4. Scopes
- [ ] `read_products`, `write_products`, `write_files` — nothing else.

### 5. Webhooks
- [ ] Webhooks API version: `2026-07`
- [ ] Topic `app/uninstalled` → `APP_URL/api/shopify/webhooks`
- [ ] Compliance topics `customers/data_request`, `customers/redact`, `shop/redact` → `APP_URL/api/shopify/webhooks`

App-specific webhook subscriptions are defined in `shopify.app.toml`
(see `shopify.app.toml.example` in the repo root) and released with
`shopify app deploy`, or in the version settings if your Dev Dashboard shows them.

- [ ] **Release** the version.

### 6. Credentials → environment variables
- [ ] Client ID → `SHOPIFY_CLIENT_ID`
- [ ] Client secret → `SHOPIFY_CLIENT_SECRET`

### 7. Test store
- [ ] Create a development store; add a few Draft and Active products (e.g. "Milano 3 Seater Sofa").
- [ ] In Product Image Sync: Stores → Add store (domain `your-dev-store.myshopify.com`) → **Connect Shopify** → approve.
- [ ] Always start installs from Product Image Sync — an install started from Shopify admin has no workspace to attach to.

## Environment variables (all server-only; never `NEXT_PUBLIC_`)

| Variable | Value |
|---|---|
| `SHOPIFY_CLIENT_ID` | Dev Dashboard → App settings |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard → App settings. **Secret.** Also used to verify HMACs. |
| `SHOPIFY_APP_URL` | Base URL, no trailing slash. `https://…` required when `NODE_ENV=production` (so `npm run start` locally needs an https URL; `npm run dev` accepts `http://localhost:3000`). |
| `SHOPIFY_SCOPES` | `read_products,write_products,write_files` |
| `SHOPIFY_API_VERSION` | `2026-07` (update quarterly) |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Secret. Never change it once tokens are stored** — existing connections would need to reconnect. |
| `SUPABASE_SECRET_KEY` | Supabase → Project Settings → API Keys → **Secret key** (`sb_secret_…`). **Secret.** Server uses it only to call the `shopify_*` database functions. |

Missing/invalid values → server logs `Shopify is not configured: missing …`
(names only) and users see "Shopify connection isn't set up yet".

## Security model

- Tokens are encrypted with **AES-256-GCM** (Node `crypto`) before storage; the
  ciphertext is bound to `store + shop + token kind` (AAD). Key only in env.
- Stored in `internal.integration_secrets` — not exposed by the Supabase API,
  no access for signed-in/anonymous users. Only `SECURITY DEFINER` functions
  executable by `service_role` touch it, and they only accept `v1.` ciphertext.
- OAuth state: 32 random bytes; only its SHA-256 hash is stored; 10-minute
  expiry; consumed once; bound to user, workspace, store and shop.
- One **active** connection per Shopify shop across all workspaces (partial
  unique index); re-authorizing a shop elsewhere would retire the first tokens.
- Tokens never appear in responses, redirects, cookies, logs, activity or n8n.

## Compliance webhooks — follow-up

`customers/data_request` and `customers/redact` are acknowledged (the app stores
no customer data). `shop/redact` is recorded; **deleting that shop's stored data
within 30 days must be implemented before App Store submission.**

## Code map

| File | Purpose |
|---|---|
| `lib/shopify/auth.ts` | `startOAuth()`, `validateCallbackQuery()`, `handleCallback()` |
| `lib/shopify/tokens.ts` | `exchangeToken()`, `refreshAccessToken()` |
| `lib/shopify/connection.ts` | `refreshTokenIfNeeded()`, `verifyConnection()`, `disconnectStore()` |
| `lib/shopify/crypto.ts` | `encryptToken()` / `decryptToken()` (AES-256-GCM) |
| `lib/shopify/repository.ts` | Calls to the service-role `shopify_*` SQL functions |
| `lib/shopify/webhooks.ts` | HMAC verification + idempotent handling |
| `lib/shopify/config.ts`, `scopes.ts`, `domain.ts`, `oauth.ts`, `client.ts`, `errors.ts`, `runtime.ts`, `types.ts` | Config, validation, low-level helpers |
| `app/api/shopify/callback/route.ts` | OAuth redirect target |
| `app/api/shopify/webhooks/route.ts` | Webhook endpoint |
| `app/(app)/stores/[id]/shopify-actions.ts` | Connect / Verify / Disconnect server actions |
| `supabase/migrations/20260930110157_shopify_oauth.sql` | Schema + functions |
| `tests/shopify-*.test.ts`, `supabase/tests/shopify_oauth_test.sql` | Tests |

## References
- Authorization code grant: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Offline access tokens (expiring + refresh): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
- Webhooks (HTTPS delivery, HMAC, duplicates): https://shopify.dev/docs/apps/build/webhooks/subscribe/https
- Webhook subscriptions (`shopify.app.toml`): https://shopify.dev/docs/apps/build/webhooks/subscribe
- Compliance webhooks: https://shopify.dev/docs/apps/build/privacy-law-compliance
- `appUninstall`: https://shopify.dev/docs/api/admin-graphql/latest/mutations/appUninstall
