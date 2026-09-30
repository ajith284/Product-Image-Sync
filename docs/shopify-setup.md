# Shopify app setup

How to create and configure the Shopify app that Product Image Sync uses to add
images to merchants' existing products. **Never commit real secrets** — they go
only in `.env.local` (local) or your host's environment settings (production).

_Last checked against shopify.dev: 2026-09-30._

## How the app connects (target design)

| Decision | Choice | Why |
|---|---|---|
| App type | **Standalone (non-embedded)** | Merchants use our dashboard, not Shopify admin. |
| Auth flow | **Authorization code grant** | The documented flow for apps running outside Shopify admin. |
| Token type | **Expiring offline access token** (`expiring=1`) | Background syncs need app-level access. Required for new public apps created on/after 2026-04-01. Access token lasts 1 hour; refresh token 90 days. |
| Distribution | **Public, unlisted** | Lets many independent merchants install one app. Custom distribution is limited to a single store/organization. |
| API | **GraphQL Admin API**, version from `SHOPIFY_API_VERSION` | REST product workflows are legacy. |
| Scopes | `read_products,write_products,write_files` | Minimum for attaching media to existing products. No orders, customers, payments, themes or inventory. |

Connection flow (built in the next phase):

```
User enters Shopify domain → validate (lib/shopify/domain.ts)
→ /api/shopify/auth  (checks user → workspace → owner/admin → store; saves hashed state)
→ Shopify approval screen
→ /api/shopify/callback  (checks shop, HMAC, state; exchanges code with expiring=1)
→ encrypted tokens → internal.integration_secrets; metadata → shopify_connections
```

## Required Shopify app settings — checklist

### 1. Create the Shopify app
- [ ] Sign in to the Shopify **Dev Dashboard** (dev.shopify.com) with your Partner/organization account.
- [ ] **Create app** → **Start from Dev Dashboard** → name it (e.g. "Product Image Sync").
- [ ] Choose **public** distribution, **unlisted** (not in the App Store) when prompted in distribution settings.

### 2. Configure the app URL
- [ ] In the app **version** settings, set **App URL** to `SHOPIFY_APP_URL`:
  - Development: `http://localhost:3000` (or an https tunnel URL if Shopify rejects http)
  - Production: `https://your-domain.com`
- [ ] Turn **off** "Embed app in Shopify admin" (non-embedded app).

### 3. Configure redirect URLs
- [ ] Add the OAuth callback as an allowed redirect URL — it must match exactly:
  - Development: `http://localhost:3000/api/shopify/callback`
  - Production: `https://your-domain.com/api/shopify/callback`

### 4. Add scopes
- [ ] Access scopes: `read_products`, `write_products`, `write_files` — nothing else.
- [ ] **Release** the version so the settings take effect.

### 5. Copy credentials into environment variables
- [ ] App settings → copy **Client ID** → `SHOPIFY_CLIENT_ID`
- [ ] App settings → copy **Client secret** → `SHOPIFY_CLIENT_SECRET` (server-only)

### 6. Install on a test store
- [ ] Create a **development store** from the Dev Dashboard (or use an existing test store).
- [ ] Add a few test products (Draft and Active) with titles like "Milano 3 Seater Sofa".
- [ ] Install the app on the test store **after** the next phase adds the OAuth routes.

## Environment variables

All are **server-only** — never prefix with `NEXT_PUBLIC_`.

| Variable | Example / format |
|---|---|
| `SHOPIFY_CLIENT_ID` | From Dev Dashboard → App settings |
| `SHOPIFY_CLIENT_SECRET` | From Dev Dashboard → App settings. **Secret.** |
| `SHOPIFY_APP_URL` | `http://localhost:3000` (dev) · `https://your-domain.com` (prod, must be https) |
| `SHOPIFY_SCOPES` | `read_products,write_products,write_files` (other scopes are rejected) |
| `SHOPIFY_API_VERSION` | Latest stable, e.g. `2026-07`. Shopify releases quarterly (Jan/Apr/Jul/Oct) and supports each version ≥ 12 months — update quarterly. |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64. Generate: `openssl rand -base64 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Secret. Never change it after tokens are stored** (existing tokens become unreadable). |

If any are missing or invalid, server code that needs Shopify throws a
`ShopifyConfigError` naming the variables (never their values). The rest of the
app keeps working.

## Security rules

- Client secret, encryption key, access and refresh tokens stay on the server
  (`lib/shopify/*` imports `server-only`; importing it from a Client Component fails the build).
- Tokens are stored encrypted in `internal.integration_secrets` (not reachable through the Supabase API).
- Never put secrets in localStorage, JavaScript-readable cookies, frontend state, logs, activity logs or n8n.
- Validate every shop domain (`normalizeShopDomain` for user input, `isValidShopDomain` for Shopify callbacks).

## Code map

| File | Purpose |
|---|---|
| `lib/shopify/config.ts` | Reads/validates env vars; `getShopifyConfig()`, `getShopifyConfigStatus()` |
| `lib/shopify/scopes.ts` | Required/allowed scopes; `hasRequiredScopes()` |
| `lib/shopify/domain.ts` | `normalizeShopDomain()`, `verifyShopDomain()`, `isValidShopDomain()` (shared) |
| `lib/shopify/client.ts` | `createShopifyClient()` — GraphQL Admin API client with friendly errors |
| `lib/shopify/oauth.ts` | OAuth preparation: state, authorize URL, callback HMAC check |
| `lib/shopify/types.ts` | Shared types |
| `tests/shopify-*.test.ts` | Unit tests (`npm test`) |

## References
- Authorization code grant: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
- Offline access tokens (expiring): https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
- Expiring tokens required for new public apps (2026-04-01): https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-public-apps-april-1-2026
- API versioning: https://shopify.dev/docs/api/usage/versioning
- Dev Dashboard: https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
