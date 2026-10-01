# Google Drive setup

How to create the Google Cloud OAuth app that Product Image Sync uses to read
product image folders from merchants' Google Drive. **Never commit real
secrets** — they go only in `.env.local` (local) or your host's environment
settings (production).

_Last checked against Google's docs: 2026-09-30._

## Scope decision

| Scope | Class | What the app can do | Fits background sync? |
|---|---|---|---|
| `openid`, `.../auth/userinfo.email` | non-sensitive | Know which Google account connected (stable id + email) | — (always requested) |
| **`.../auth/drive.readonly`** (default) | **restricted** | Read folders and files the user can see, including images added later | **Yes** |
| `.../auth/drive.file` | non-sensitive | Only files/folders the user picks in Google Picker | Not reliably — Google documents it as *per-file* access; folder contents and images added later are not guaranteed |
| `drive`, `drive.metadata.readonly`, … | restricted | Broader than needed (write access / metadata only) | Rejected by config |

**Selected: `drive.readonly`** — the narrowest scope that can list the chosen root
folder's product sub-folders and download new images during unattended runs.
The app never writes to Drive.

Consequence: `drive.readonly` is a **restricted** scope. While the Google app is in
**Testing** it works for up to 100 listed test users without verification. A
public, production app must pass Google's **OAuth verification + an annual CASA
security assessment**. If that is not acceptable, set `GOOGLE_DRIVE_SCOPES=drive.file`
(no code changes) — then folder selection in Prompt 7 must use Google Picker and
new images may need the merchant to re-select the folder.

## How the connection works

```
Store page → [Connect Google Drive]                     (owner/admin only)
  server action: session → workspace → role → store in workspace
  → random state; SHA-256 hash in internal.oauth_states (provider google_drive,
    user + workspace + store, 10 min, one-time)
  → redirect accounts.google.com (access_type=offline, prompt=consent,
    PKCE S256 derived from the state)
User approves in Google
  → GET /api/google/callback
     1. consume state (unknown / reused / expired → rejected)
     2. same signed-in user as when it started
     3. Google error? (access_denied → friendly message)
     4. ONLY THEN: POST oauth2.googleapis.com/token (code + PKCE verifier)
     5. Drive scope actually granted (users can untick it)
     6. identity from the ID token (iss, aud, exp, sub checked)
     7. AES-256-GCM encrypt tokens → save connection + secrets atomically
        (DB re-checks owner/admin + store/workspace)
     8. read-only verification: Drive about.get → "Google Drive Connected ✓"
```

**Verify** re-runs step 8. **Reconnect** repeats the flow; a different Google
account clears the old root folder. **Disconnect** deletes the stored tokens and
revokes Google's grant — unless another store still uses the same Google account
(Google revokes the whole account↔app grant, which would break that store).

## Checklist — Google Cloud Console

Replace `APP_URL` with your app's base URL (e.g. `http://localhost:3000`,
your https tunnel, or `https://your-domain.com`).

### 1. Project
- [ ] https://console.cloud.google.com → project picker → **New project** → name "Product Image Sync" → **Create**.

### 2. Enable the Drive API
- [ ] **APIs & Services → Library** → search **Google Drive API** → **Enable**.

### 3. Consent screen (Google Auth Platform)
- [ ] Menu → **Google Auth Platform → Branding** (first time: **Get started**): App name "Product Image Sync", user support email, developer contact email → agree to the User Data Policy → **Create**.
- [ ] **Audience**: user type **External**; publishing status stays **Testing** for now.
- [ ] **Audience → Test users → Add users**: every Google account you will connect while testing (max 100).
- [ ] **Data Access → Add or Remove Scopes**: `openid`, `.../auth/userinfo.email`, `.../auth/drive.readonly` → **Update** → **Save**.

### 4. OAuth client
- [ ] **Google Auth Platform → Clients → Create client** → Application type **Web application** → name "Product Image Sync web".
- [ ] **Authorized redirect URIs** → add exactly `APP_URL/api/google/callback` for every URL you use, e.g.
  - `http://localhost:3000/api/google/callback`
  - `https://<your-tunnel>/api/google/callback`
  - `https://your-domain.com/api/google/callback`
- [ ] (Authorized JavaScript origins: not needed yet.)
- [ ] **Create** → copy the **Client ID** and **Client secret** (download the JSON; the secret may not be shown again).

### 5. Environment variables (`.env.local`, then restart `npm run dev`)

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | `…apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Client secret. **Secret.** |
| `GOOGLE_REDIRECT_URI` | `APP_URL/api/google/callback` — must match one registered URI exactly. `https://` required in production; `http://localhost` allowed in development. |
| `GOOGLE_DRIVE_SCOPES` | `drive.readonly` (or `drive.file`, see above). Exactly one. |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`. **Secret.** Separate from the Shopify key. Never change it once tokens are stored (connections would need reconnecting). |

All are server-only; never prefix them with `NEXT_PUBLIC_`. Missing/invalid
values → server log `Google Drive is not configured: missing …` (names only) and
users see "Google Drive connection isn't set up yet".

### 6. Test
- [ ] Store page → **Connect Google Drive** → choose a test-user account → allow Drive access → back on the store page: **Google Drive Connected ✓ · Account: you@gmail.com**.

## Testing-mode limits (important)
- Only listed test users can connect (max 100); they see an "unverified app" notice.
- **Authorizations expire after 7 days** in Testing (refresh tokens included) — the store
  will show "Needs reconnect"; click **Reconnect**.

## Going to production
- **Google Auth Platform → Audience → Publish app**.
- Complete **verification** (Branding: homepage, privacy policy, authorized domains;
  Data Access: justification + demo video for `drive.readonly`).
- Restricted scope → **CASA security assessment**, renewed every 12 months.
- Until approved, users outside the test list can't connect.

## Security model
- Tokens are encrypted with **AES-256-GCM** before storage, bound to
  `google_drive:<storeId>:<access|refresh>` (AAD) with `GOOGLE_TOKEN_ENCRYPTION_KEY`.
- Stored only in `internal.integration_secrets` (provider `google_drive`) —
  not exposed by the Supabase API; only service-role `google_*` functions touch it
  and they accept only `v1.` ciphertext. `google_drive_connections` holds
  metadata only (status, account email, scopes, dates).
- Never in cookies, the browser, local storage, logs, activity entries or n8n.

## Code map

| File | Purpose |
|---|---|
| `lib/google/config.ts` | Env validation, scopes |
| `lib/google/auth.ts` | `startGoogleOAuth()`, `handleGoogleCallback()` |
| `lib/google/connection.ts` | `saveGoogleConnection()`, `refreshGoogleToken()`, `getDriveClient()`, `verifyGoogleConnection()`, `disconnectGoogle()` |
| `lib/google/tokens.ts` | Token endpoint (exchange / refresh / revoke), ID token checks |
| `lib/google/client.ts` | Read-only Drive v3 client (`get`, `getAbout`) — listing/downloading is Prompt 7 |
| `lib/google/crypto.ts` | Token context + PKCE (reuses `lib/security/token-crypto.ts`) |
| `lib/google/repository.ts` | Calls to the service-role `google_*` SQL functions |
| `lib/security/oauth-state.ts` | One-time state shared with Shopify |
| `app/api/google/callback/route.ts` | OAuth redirect target |
| `app/(app)/stores/[id]/google-actions.ts` | Connect / Verify / Disconnect |
| `components/stores/google-drive-card.tsx` | Store page card |
| `supabase/migrations/20260930165808_google_drive_oauth.sql` | Columns + functions |
| `tests/google-*.test.ts`, `supabase/tests/google_drive_oauth_test.sql` | Tests |

## References
- Choose Drive API scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- OAuth 2.0 for web server apps: https://developers.google.com/identity/protocols/oauth2/web-server
- Restricted scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Configure the consent screen: https://developers.google.com/workspace/guides/configure-oauth-consent
- Publishing status (Testing limits): https://support.google.com/cloud/answer/15549945
