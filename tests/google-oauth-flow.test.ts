import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleGoogleCallback, startGoogleOAuth } from "@/lib/google/auth";
import { createDriveClient, DriveApiError } from "@/lib/google/client";
import { disconnectGoogle, refreshGoogleToken, verifyGoogleConnection, type GoogleDeps } from "@/lib/google/connection";
import { decryptToken, encryptToken, googleTokenContext } from "@/lib/google/crypto";
import { GoogleFlowError } from "@/lib/google/errors";
import { readIdToken } from "@/lib/google/tokens";
import { hashOAuthState } from "@/lib/security/oauth-state";
import {
  aboutOk,
  ACCESS,
  DRIVE_READONLY,
  fakeGoogleRepo,
  G_NOW,
  G_STORE_ID,
  G_USER_ID,
  G_WORKSPACE_ID,
  googleConfig,
  googleFetch,
  idToken,
  json,
  REFRESH,
  tokenBody,
} from "./helpers/google-fakes";

const KEY = googleConfig.tokenEncryptionKey;

function deps(fetchImpl: ReturnType<typeof googleFetch>) {
  const { repo, state } = fakeGoogleRepo();
  const d: GoogleDeps = { config: googleConfig, repo, fetch: fetchImpl as unknown as typeof fetch, now: () => G_NOW };
  return { deps: d, repo, state };
}

async function startAndGetState(d: GoogleDeps) {
  const url = new URL(await startGoogleOAuth({ userId: G_USER_ID, storeId: G_STORE_ID }, d));
  return { url, state: url.searchParams.get("state")! };
}

function callbackQuery(params: Record<string, string>) {
  return new URLSearchParams(params);
}

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("startGoogleOAuth", () => {
  it("builds Google's consent URL with offline access, PKCE and a one-time state", async () => {
    const f = googleFetch({});
    const { deps: d, state: repoState } = deps(f);
    const { url, state } = await startAndGetState(d);

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(googleConfig.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(`openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_READONLY}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.toString()).not.toContain(googleConfig.clientSecret);

    // Only the hash is stored, bound to user + store, 10 minutes.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repoState.begun).toEqual([{ userId: G_USER_ID, storeId: G_STORE_ID, stateHash: hashOAuthState(state), ttlSeconds: 600 }]);
    expect(JSON.stringify(repoState.begun)).not.toContain(state);
    expect(f).not.toHaveBeenCalled();
  });

  it("each start gets a fresh state", async () => {
    const { deps: d } = deps(googleFetch({}));
    const a = await startAndGetState(d);
    const b = await startAndGetState(d);
    expect(a.state).not.toBe(b.state);
    expect(a.url.searchParams.get("code_challenge")).not.toBe(b.url.searchParams.get("code_challenge"));
  });

  it("database refusal (member / other workspace) → forbidden, with store id", async () => {
    const { deps: d, repo } = deps(googleFetch({}));
    vi.mocked(repo.beginOAuth).mockRejectedValueOnce(new GoogleFlowError("forbidden"));
    await expect(startGoogleOAuth({ userId: G_USER_ID, storeId: G_STORE_ID }, d)).rejects.toMatchObject({
      code: "forbidden",
      storeId: G_STORE_ID,
    });
  });
});

describe("handleGoogleCallback — rejected before any token exchange", () => {
  const cases: [string, (s: ReturnType<typeof fakeGoogleRepo>["state"]) => void, Record<string, string>, string][] = [
    ["missing state", () => {}, { code: "c" }, "invalid_state"],
    ["malformed state", () => {}, { code: "c", state: "bad state!" }, "invalid_state"],
    ["invalid (unknown) state", (s) => (s.consumed = { status: "unknown" }), { code: "c", state: "abc" }, "invalid_state"],
    ["reused state", (s) => (s.consumed = { status: "reused" }), { code: "c", state: "abc" }, "reused_state"],
    ["expired state", (s) => (s.consumed = { status: "expired" }), { code: "c", state: "abc" }, "expired_state"],
  ];

  it.each(cases)("%s", async (_label, setup, params, code) => {
    const f = googleFetch({ token: () => json(tokenBody()) });
    const { deps: d, state, repo } = deps(f);
    setup(state);
    await expect(handleGoogleCallback({ query: callbackQuery(params), sessionUserId: G_USER_ID }, d)).rejects.toMatchObject({
      code,
    });
    expect(f).not.toHaveBeenCalled();
    expect(repo.saveConnection).not.toHaveBeenCalled();
  });

  it("state is consumed via its hash (one-time use enforced by the DB)", async () => {
    const { deps: d, repo } = deps(googleFetch({ token: () => json(tokenBody()), drive: () => aboutOk() }));
    const { state } = await startAndGetState(d);
    await handleGoogleCallback({ query: callbackQuery({ code: "c", state }), sessionUserId: G_USER_ID }, d);
    expect(repo.consumeState).toHaveBeenCalledWith(hashOAuthState(state));
  });

  it.each([
    ["signed out", null],
    ["a different user", "77777777-7777-4777-8777-777777777777"],
  ])("session mismatch (%s) → rejected, no exchange", async (_label, sessionUserId) => {
    const f = googleFetch({ token: () => json(tokenBody()) });
    const { deps: d } = deps(f);
    await expect(
      handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId }, d),
    ).rejects.toMatchObject({ code: "session_mismatch", storeId: G_STORE_ID });
    expect(f).not.toHaveBeenCalled();
  });

  it("user declined on Google → access_denied (state still consumed)", async () => {
    const f = googleFetch({});
    const { deps: d, repo } = deps(f);
    await expect(
      handleGoogleCallback({ query: callbackQuery({ error: "access_denied", state: "abc" }), sessionUserId: G_USER_ID }, d),
    ).rejects.toMatchObject({ code: "access_denied", storeId: G_STORE_ID });
    expect(repo.consumeState).toHaveBeenCalledTimes(1);
    expect(f).not.toHaveBeenCalled();
  });

  it("missing code → invalid_request", async () => {
    const { deps: d } = deps(googleFetch({}));
    await expect(
      handleGoogleCallback({ query: callbackQuery({ state: "abc" }), sessionUserId: G_USER_ID }, d),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("handleGoogleCallback — exchange, identity, storage", () => {
  it("happy path: PKCE exchange → encrypted storage → verified", async () => {
    const tokenCalls: URLSearchParams[] = [];
    const f = googleFetch({
      token: (_u, init) => {
        tokenCalls.push(new URLSearchParams(String(init.body)));
        return json(tokenBody());
      },
      drive: (u, init) => {
        expect(u.pathname).toBe("/drive/v3/about");
        expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);
        return aboutOk();
      },
    });
    const { deps: d, state: repoState, repo } = deps(f);
    const { url, state } = await startAndGetState(d);

    const result = await handleGoogleCallback({ query: callbackQuery({ code: "auth-code", state }), sessionUserId: G_USER_ID }, d);
    expect(result).toEqual({ storeId: G_STORE_ID, verified: true, email: "owner@gmail.com" });

    // Token request: code + PKCE verifier matching the challenge sent to Google.
    const p = tokenCalls[0]!;
    expect(p.get("grant_type")).toBe("authorization_code");
    expect(p.get("code")).toBe("auth-code");
    expect(p.get("redirect_uri")).toBe(googleConfig.redirectUri);
    expect(p.get("client_secret")).toBe(googleConfig.clientSecret);
    const challenge = createHash("sha256").update(p.get("code_verifier")!).digest("base64url");
    expect(challenge).toBe(url.searchParams.get("code_challenge"));

    // Saved: identity + scopes + ENCRYPTED tokens only.
    const saved = repoState.saved!;
    expect(saved).toMatchObject({
      storeId: G_STORE_ID,
      workspaceId: G_WORKSPACE_ID,
      userId: G_USER_ID,
      googleAccountId: "google-sub-123",
      googleAccountEmail: "owner@gmail.com",
    });
    expect(saved.scopes.split(" ")).toContain(DRIVE_READONLY);
    expect(saved.encryptedAccessToken).toMatch(/^v1\./);
    expect(saved.encryptedRefreshToken).toMatch(/^v1\./);
    expect(JSON.stringify(saved)).not.toContain(ACCESS);
    expect(JSON.stringify(saved)).not.toContain(REFRESH);
    expect(decryptToken(saved.encryptedAccessToken, KEY, googleTokenContext(G_STORE_ID, "access"))).toBe(ACCESS);
    expect(decryptToken(saved.encryptedRefreshToken!, KEY, googleTokenContext(G_STORE_ID, "refresh"))).toBe(REFRESH);
    expect(saved.accessExpiresAt?.getTime()).toBe(G_NOW + 3599 * 1000);

    expect(repo.recordVerification).toHaveBeenCalledWith(expect.objectContaining({ storeId: G_STORE_ID, ok: true, accountEmail: "owner@gmail.com" }));
    for (const line of logs) {
      expect(line).not.toContain(ACCESS);
      expect(line).not.toContain(REFRESH);
    }
  });

  it("user unticked Drive access → missing_scopes, nothing saved", async () => {
    const f = googleFetch({ token: () => json(tokenBody({ scope: "openid https://www.googleapis.com/auth/userinfo.email" })) });
    const { deps: d, repo } = deps(f);
    await expect(
      handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId: G_USER_ID }, d),
    ).rejects.toMatchObject({ code: "missing_scopes", storeId: G_STORE_ID });
    expect(repo.saveConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["no id_token", { id_token: undefined }],
    ["wrong audience", { id_token: idToken({ aud: "someone-else.apps.googleusercontent.com" }) }],
    ["wrong issuer", { id_token: idToken({ iss: "https://evil.example.com" }) }],
    ["expired", { id_token: idToken({ exp: Math.floor(G_NOW / 1000) - 3600 }) }],
  ])("identity check fails (%s) → invalid_identity", async (_label, overrides) => {
    const { deps: d, repo } = deps(googleFetch({ token: () => json(tokenBody(overrides)) }));
    await expect(
      handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId: G_USER_ID }, d),
    ).rejects.toMatchObject({ code: "invalid_identity" });
    expect(repo.saveConnection).not.toHaveBeenCalled();
  });

  it("unverified email is not stored as the account email", async () => {
    const { deps: d, state } = deps(
      googleFetch({ token: () => json(tokenBody({ id_token: idToken({ email_verified: false }) })), drive: () => aboutOk() }),
    );
    await handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId: G_USER_ID }, d);
    expect(state.saved?.googleAccountEmail).toBeNull();
  });

  it("Google rejects the code → exchange_failed; response body never surfaces", async () => {
    const { deps: d } = deps(googleFetch({ token: () => json({ error: "invalid_grant", error_description: "Bad Request" }, 400) }));
    const err = await handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId: G_USER_ID }, d).catch((e) => e);
    expect(err).toMatchObject({ code: "exchange_failed", storeId: G_STORE_ID });
    expect(err.message).not.toContain("invalid_grant");
  });

  it("DB refuses (no refresh token on first connect) → missing_refresh_token with store id", async () => {
    const { deps: d, repo } = deps(googleFetch({ token: () => json(tokenBody({ refresh_token: undefined })) }));
    vi.mocked(repo.saveConnection).mockRejectedValueOnce(new GoogleFlowError("missing_refresh_token"));
    await expect(
      handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId: G_USER_ID }, d),
    ).rejects.toMatchObject({ code: "missing_refresh_token", storeId: G_STORE_ID });
  });

  it("Drive API not enabled → saved but unverified; recorded as a problem", async () => {
    const { deps: d, repo } = deps(
      googleFetch({
        token: () => json(tokenBody()),
        drive: () => json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, 403),
      }),
    );
    const r = await handleGoogleCallback({ query: callbackQuery({ code: "c", state: "abc" }), sessionUserId: G_USER_ID }, d);
    expect(r.verified).toBe(false);
    expect(repo.recordVerification).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, failureStatus: "error", error: "Google Drive isn't enabled for this app yet. Please contact your administrator." }),
    );
  });

  it("readIdToken rejects malformed tokens", () => {
    expect(readIdToken("not-a-jwt", googleConfig.clientId, G_NOW)).toBeNull();
    expect(readIdToken("a.b.c", googleConfig.clientId, G_NOW)).toBeNull();
    expect(readIdToken(idToken({ sub: "" }), googleConfig.clientId, G_NOW)).toBeNull();
  });
});

function withCreds(state: ReturnType<typeof fakeGoogleRepo>["state"], over: Record<string, unknown> = {}) {
  state.creds = {
    connectionId: "gconn-1",
    workspaceId: G_WORKSPACE_ID,
    googleAccountId: "google-sub-123",
    connectionStatus: "connected",
    encryptedAccessToken: encryptToken(ACCESS, KEY, googleTokenContext(G_STORE_ID, "access")),
    encryptedRefreshToken: encryptToken(REFRESH, KEY, googleTokenContext(G_STORE_ID, "refresh")),
    tokenExpiresAt: new Date(G_NOW + 3_600_000),
    tokenVersion: 1,
    accountShared: false,
    ...over,
  };
}

describe("refreshGoogleToken", () => {
  it("fresh token: no network call", async () => {
    const f = googleFetch({});
    const { deps: d, state } = deps(f);
    withCreds(state);
    expect((await refreshGoogleToken(G_STORE_ID, d)).accessToken).toBe(ACCESS);
    expect(f).not.toHaveBeenCalled();
  });

  it("expiring token: refreshes, stores the new one encrypted, keeps refresh token", async () => {
    let body: URLSearchParams | null = null;
    const f = googleFetch({
      token: (_u, init) => {
        body = new URLSearchParams(String(init.body));
        return json({ access_token: "ya29.NEW", expires_in: 3599, scope: DRIVE_READONLY, token_type: "Bearer" });
      },
    });
    const { deps: d, state, repo } = deps(f);
    withCreds(state, { tokenExpiresAt: new Date(G_NOW + 60_000) });
    const r = await refreshGoogleToken(G_STORE_ID, d);
    expect(r.accessToken).toBe("ya29.NEW");
    expect(body!.get("grant_type")).toBe("refresh_token");
    expect(body!.get("refresh_token")).toBe(REFRESH);
    expect(repo.storeRefreshedTokens).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, encryptedRefreshToken: null }));
    expect(decryptToken(state.creds!.encryptedAccessToken!, KEY, googleTokenContext(G_STORE_ID, "access"))).toBe("ya29.NEW");
  });

  it("revoked / expired refresh token (invalid_grant) → needs_reconnect recorded", async () => {
    const { deps: d, state, repo } = deps(googleFetch({ token: () => json({ error: "invalid_grant" }, 400) }));
    withCreds(state, { tokenExpiresAt: new Date(G_NOW - 1) });
    await expect(refreshGoogleToken(G_STORE_ID, d)).rejects.toMatchObject({ code: "needs_reconnect" });
    expect(repo.recordVerification).toHaveBeenCalledWith(expect.objectContaining({ ok: false, failureStatus: "needs_reconnect" }));
  });

  it("Google temporarily unavailable → verify_failed, status untouched", async () => {
    const { deps: d, state, repo } = deps(googleFetch({ token: () => json({}, 503) }));
    withCreds(state, { tokenExpiresAt: new Date(G_NOW - 1) });
    await expect(refreshGoogleToken(G_STORE_ID, d)).rejects.toMatchObject({ code: "verify_failed" });
    expect(repo.recordVerification).not.toHaveBeenCalled();
  });

  it("ciphertext from another store (or wrong key) → needs_reconnect", async () => {
    const { deps: d, state } = deps(googleFetch({}));
    withCreds(state, { encryptedAccessToken: encryptToken(ACCESS, KEY, googleTokenContext("other-store", "access")) });
    await expect(refreshGoogleToken(G_STORE_ID, d)).rejects.toMatchObject({ code: "needs_reconnect" });
  });

  it("a Shopify-encrypted value can't be used as a Google token", async () => {
    const { deps: d, state } = deps(googleFetch({}));
    withCreds(state, { encryptedAccessToken: encryptToken(ACCESS, KEY, `shopify:${G_STORE_ID}:x.myshopify.com:access`) });
    await expect(refreshGoogleToken(G_STORE_ID, d)).rejects.toMatchObject({ code: "needs_reconnect" });
  });

  it("not connected → not_connected", async () => {
    const { deps: d } = deps(googleFetch({}));
    await expect(refreshGoogleToken(G_STORE_ID, d)).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("verifyGoogleConnection", () => {
  it("401 from Drive → one forced refresh, then success", async () => {
    let driveCalls = 0;
    const f = googleFetch({
      token: () => json({ access_token: "ya29.RETRY", expires_in: 3599, scope: DRIVE_READONLY }),
      drive: (_u, init) => {
        driveCalls += 1;
        const auth = new Headers(init.headers).get("Authorization");
        return auth === "Bearer ya29.RETRY" ? aboutOk() : json({ error: { code: 401 } }, 401);
      },
    });
    const { deps: d, state } = deps(f);
    withCreds(state);
    expect(await verifyGoogleConnection(G_STORE_ID, d)).toEqual({ ok: true, email: "owner@gmail.com" });
    expect(driveCalls).toBe(2);
  });

  it("insufficient scope → needs_reconnect", async () => {
    const { deps: d, state } = deps(
      googleFetch({ drive: () => json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403) }),
    );
    withCreds(state);
    expect(await verifyGoogleConnection(G_STORE_ID, d)).toMatchObject({ ok: false, code: "needs_reconnect" });
  });
});

describe("disconnectGoogle", () => {
  it("revokes Google's grant when no other store uses the account, then deletes credentials", async () => {
    const revoked: string[] = [];
    const f = googleFetch({
      revoke: (_u, init) => {
        revoked.push(new URLSearchParams(String(init.body)).get("token")!);
        return new Response("", { status: 200 });
      },
    });
    const { deps: d, state, repo } = deps(f);
    withCreds(state);
    expect(await disconnectGoogle(G_STORE_ID, G_USER_ID, d)).toEqual({ revoked: true });
    expect(revoked).toEqual([REFRESH]);
    expect(repo.disconnect).toHaveBeenCalledWith(G_STORE_ID, G_USER_ID);
  });

  it("does NOT revoke when another store uses the same Google account (would break it)", async () => {
    const f = googleFetch({ revoke: () => new Response("", { status: 200 }) });
    const { deps: d, state, repo } = deps(f);
    withCreds(state, { accountShared: true });
    expect(await disconnectGoogle(G_STORE_ID, G_USER_ID, d)).toEqual({ revoked: false });
    expect(f).not.toHaveBeenCalled();
    expect(repo.disconnect).toHaveBeenCalledTimes(1);
  });

  it("still deletes credentials when Google is unreachable", async () => {
    const f = googleFetch({
      revoke: () => {
        throw new Error("offline");
      },
    });
    const { deps: d, state, repo } = deps(f);
    withCreds(state);
    expect(await disconnectGoogle(G_STORE_ID, G_USER_ID, d)).toEqual({ revoked: false });
    expect(repo.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("createDriveClient", () => {
  const make = (status: number, body: unknown) =>
    createDriveClient({ accessToken: "tok", fetch: vi.fn(async () => json(body, status)) as unknown as typeof fetch });

  it.each([
    [401, {}, "unauthorized"],
    [403, { error: { errors: [{ reason: "accessNotConfigured" }] } }, "api_disabled"],
    [403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, "api_disabled"],
    [403, { error: { errors: [{ reason: "insufficientPermissions" }] } }, "insufficient_scope"],
    [403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, "throttled"],
    [403, { error: { errors: [{ reason: "forbidden" }] } }, "forbidden"],
    [404, {}, "not_found"],
    [429, {}, "throttled"],
    [503, {}, "unavailable"],
  ])("HTTP %i → %s", async (status, body, kind) => {
    const err = (await make(status, body).get("about").catch((e: unknown) => e)) as DriveApiError;
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain("tok");
  });

  it("only GET requests to the Drive v3 API; rejects unsafe paths", async () => {
    const f = vi.fn(async () => json({ user: { emailAddress: "a@b.c" } }));
    const c = createDriveClient({ accessToken: "tok", fetch: f as unknown as typeof fetch });
    await c.getAbout();
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://www.googleapis.com/drive/v3/about?fields=user%28emailAddress%2CdisplayName%29");
    expect(init.method).toBe("GET");
    await expect(c.get("../oauth2/v1/tokeninfo")).rejects.toThrow(/invalid path/);
    await expect(c.get("https://evil.example.com")).rejects.toThrow(/invalid path/);
  });
});
