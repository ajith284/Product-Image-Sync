import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { handleCallback, startOAuth } from "@/lib/shopify/auth";
import { disconnectStore, refreshTokenIfNeeded, verifyConnection } from "@/lib/shopify/connection";
import { decryptToken, encryptToken, tokenContext } from "@/lib/shopify/crypto";
import { hashOAuthState } from "@/lib/shopify/oauth";
import { handleShopifyWebhook } from "@/lib/shopify/webhooks";

import {
  config,
  fakeRepo,
  json,
  NOW,
  SHOP,
  shopifyFetch,
  signedCallback,
  STORE_ID,
  tokenResponse,
  USER_ID,
  verifyResponse,
} from "./helpers/shopify-fakes";

const TS = String(Math.floor(NOW / 1000));
const baseParams = { code: "auth-code-123", shop: SHOP, state: "state-abc", timestamp: TS };

function setup(overrides: Parameters<typeof fakeRepo>[0] = {}) {
  const { repo, state } = fakeRepo(overrides);
  const fetchMock = shopifyFetch({ token: () => tokenResponse(), graphql: () => verifyResponse() });
  return { repo, state, fetchMock, deps: { config, repo, fetch: fetchMock as unknown as typeof fetch, now: () => NOW } };
}

// ---------------------------------------------------------------------------
describe("startOAuth", () => {
  it("stores only the state hash and returns the Shopify authorize URL", async () => {
    const { repo, deps } = setup();
    const url = new URL(await startOAuth({ userId: USER_ID, storeId: STORE_ID, storeShopDomain: SHOP }, deps));
    expect(url.origin + url.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`);
    const state = url.searchParams.get("state")!;
    const call = vi.mocked(repo.beginOAuth).mock.calls[0]![0];
    expect(call.stateHash).toBe(hashOAuthState(state));
    expect(call.stateHash).not.toBe(state);
    expect(call.ttlSeconds).toBe(600);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.toString()).not.toContain(config.clientSecret);
  });

  it("never builds a URL from an unchecked domain", async () => {
    const { repo, deps } = setup();
    for (const bad of ["evil.com", "https://royal-sofa.myshopify.com", null, "Royal-Sofa.myshopify.com"]) {
      const err = await startOAuth({ userId: USER_ID, storeId: STORE_ID, storeShopDomain: bad }, deps).catch((e) => e);
      expect(err.code).toBe("invalid_shop_domain");
    }
    expect(repo.beginOAuth).not.toHaveBeenCalled();
  });

  it("surfaces DB refusals (e.g. shop connected elsewhere, forbidden)", async () => {
    const { ShopifyFlowError } = await import("@/lib/shopify/errors");
    const { deps } = setup({ beginOAuth: vi.fn(async () => { throw new ShopifyFlowError("shop_connected_elsewhere"); }) });
    const err = await startOAuth({ userId: USER_ID, storeId: STORE_ID, storeShopDomain: SHOP }, deps).catch((e) => e);
    expect(err.code).toBe("shop_connected_elsewhere");
  });
});

// ---------------------------------------------------------------------------
describe("handleCallback — valid install", () => {
  it("validates, exchanges, encrypts, saves and verifies", async () => {
    const { repo, state, fetchMock, deps } = setup();
    const result = await handleCallback({ query: signedCallback(baseParams), sessionUserId: USER_ID }, deps);

    expect(result).toEqual({ storeId: STORE_ID, verified: true });
    expect(repo.consumeState).toHaveBeenCalledWith(hashOAuthState("state-abc"));

    // Tokens are stored encrypted only, bound to this store+shop.
    const saved = state.saved!;
    expect(saved.encryptedAccessToken.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("shpat_ACCESS_SECRET_1");
    expect(JSON.stringify(saved)).not.toContain("shprt_REFRESH_SECRET_1");
    expect(decryptToken(saved.encryptedAccessToken, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "access"))).toBe("shpat_ACCESS_SECRET_1");
    expect(decryptToken(saved.encryptedRefreshToken!, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "refresh"))).toBe("shprt_REFRESH_SECRET_1");
    expect(saved.accessExpiresAt?.getTime()).toBe(NOW + 3600_000);

    // Verification: read-only GraphQL query, then recorded as connected.
    const gql = fetchMock.mock.calls.find(([u]) => String(u).includes("graphql.json"))!;
    const body = JSON.parse(String((gql[1] as RequestInit).body));
    expect(body.query).toMatch(/query VerifyConnection/);
    expect(body.query).not.toMatch(/mutation/);
    expect(state.verifications.at(-1)).toMatchObject({ storeId: STORE_ID, ok: true, shopifyShopId: "gid://shopify/Shop/42" });
  });

  it("reports connected-but-unverified when the check fails transiently", async () => {
    const { deps } = setup();
    deps.fetch = shopifyFetch({ token: () => tokenResponse(), graphql: () => json({}, 503) }) as unknown as typeof fetch;
    const result = await handleCallback({ query: signedCallback(baseParams), sessionUserId: USER_ID }, deps);
    expect(result.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("handleCallback — rejected before any code exchange", () => {
  const cases: [string, () => ReturnType<typeof setup>, URLSearchParams, string | null, string][] = [
    ["invalid HMAC", () => setup(), (() => { const q = signedCallback(baseParams); q.set("hmac", "0".repeat(64)); return q; })(), USER_ID, "invalid_hmac"],
    ["HMAC signed with another secret", () => setup(), signedCallback(baseParams, "attacker-secret"), USER_ID, "invalid_hmac"],
    ["tampered param after signing", () => setup(), (() => { const q = signedCallback(baseParams); q.set("code", "other"); return q; })(), USER_ID, "invalid_hmac"],
    ["stale timestamp", () => setup(), signedCallback({ ...baseParams, timestamp: String(Number(TS) - 3600) }), USER_ID, "stale_request"],
    ["future timestamp", () => setup(), signedCallback({ ...baseParams, timestamp: String(Number(TS) + 3600) }), USER_ID, "stale_request"],
    ["invalid shop", () => setup(), signedCallback({ ...baseParams, shop: "evil.com" }), USER_ID, "invalid_shop_domain"],
    ["missing code", () => setup(), signedCallback({ shop: SHOP, state: "s", timestamp: TS }), USER_ID, "invalid_request"],
    ["unknown state", () => { const s = setup(); s.state.consumed = { status: "unknown" }; return s; }, signedCallback(baseParams), USER_ID, "invalid_state"],
    ["expired state", () => { const s = setup(); s.state.consumed = { status: "expired" }; return s; }, signedCallback(baseParams), USER_ID, "expired_state"],
    ["reused state", () => { const s = setup(); s.state.consumed = { status: "reused" }; return s; }, signedCallback(baseParams), USER_ID, "reused_state"],
    ["different signed-in user", () => setup(), signedCallback(baseParams), "44444444-4444-4444-8444-444444444444", "session_mismatch"],
    ["signed out", () => setup(), signedCallback(baseParams), null, "session_mismatch"],
    ["shop differs from the one that started OAuth", () => setup(), signedCallback({ ...baseParams, shop: "other-shop.myshopify.com" }), USER_ID, "shop_mismatch"],
  ];

  it.each(cases)("%s → %s", async (_name, make, query, sessionUserId, expected) => {
    const s = make();
    const err = await handleCallback({ query, sessionUserId }, s.deps).catch((e) => e);
    expect(err.code).toBe(expected);
    expect(s.fetchMock).not.toHaveBeenCalled(); // never exchanged
    expect(s.repo.saveConnection).not.toHaveBeenCalled();
  });

  it("HMAC/shop/timestamp failures don't even touch the state table", async () => {
    const s = setup();
    await handleCallback({ query: signedCallback(baseParams, "wrong"), sessionUserId: USER_ID }, s.deps).catch(() => {});
    expect(s.repo.consumeState).not.toHaveBeenCalled();
  });
});

describe("handleCallback — after exchange", () => {
  it("rejects when Shopify grants fewer scopes, and stores nothing", async () => {
    const s = setup();
    s.deps.fetch = shopifyFetch({ token: () => tokenResponse({ scope: "read_products" }) }) as unknown as typeof fetch;
    const err = await handleCallback({ query: signedCallback(baseParams), sessionUserId: USER_ID }, s.deps).catch((e) => e);
    expect(err.code).toBe("missing_scopes");
    expect(err.storeId).toBe(STORE_ID);
    expect(s.repo.saveConnection).not.toHaveBeenCalled();
  });

  it("maps a failed exchange", async () => {
    const s = setup();
    s.deps.fetch = shopifyFetch({ token: () => json({ error: "invalid_grant" }, 400) }) as unknown as typeof fetch;
    const err = await handleCallback({ query: signedCallback(baseParams), sessionUserId: USER_ID }, s.deps).catch((e) => e);
    expect(err.code).toBe("exchange_failed");
    expect(err.storeId).toBe(STORE_ID);
  });

  it("propagates the one-active-connection-per-shop rule", async () => {
    const { ShopifyFlowError } = await import("@/lib/shopify/errors");
    const s = setup({ saveConnection: vi.fn(async () => { throw new ShopifyFlowError("shop_connected_elsewhere"); }) });
    const err = await handleCallback({ query: signedCallback(baseParams), sessionUserId: USER_ID }, s.deps).catch((e) => e);
    expect(err.code).toBe("shop_connected_elsewhere");
    expect(err.storeId).toBe(STORE_ID);
  });
});

// ---------------------------------------------------------------------------
function withCreds(s: ReturnType<typeof setup>, opts: { accessExpiresIn: number; refreshExpiresIn?: number | null; version?: number }) {
  const key = config.tokenEncryptionKey;
  s.state.creds = {
    connectionId: "conn-1",
    workspaceId: "ws",
    shopDomain: SHOP,
    connectionStatus: "connected",
    encryptedAccessToken: encryptToken("shpat_OLD", key, tokenContext(STORE_ID, SHOP, "access")),
    encryptedRefreshToken: encryptToken("shprt_OLD", key, tokenContext(STORE_ID, SHOP, "refresh")),
    tokenExpiresAt: new Date(NOW + opts.accessExpiresIn),
    refreshTokenExpiresAt: opts.refreshExpiresIn === null ? null : new Date(NOW + (opts.refreshExpiresIn ?? 86_400_000)),
    tokenVersion: opts.version ?? 3,
  };
}

describe("refreshTokenIfNeeded", () => {
  it("uses the stored token while it is fresh", async () => {
    const s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    const r = await refreshTokenIfNeeded(STORE_ID, s.deps);
    expect(r.accessToken).toBe("shpat_OLD");
    expect(s.fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes near expiry and stores rotated tokens with optimistic locking", async () => {
    const s = setup();
    withCreds(s, { accessExpiresIn: 60_000 });
    s.deps.fetch = shopifyFetch({ token: () => tokenResponse({ access_token: "shpat_NEW", refresh_token: "shprt_NEW" }) }) as unknown as typeof fetch;
    const r = await refreshTokenIfNeeded(STORE_ID, s.deps);
    expect(r.accessToken).toBe("shpat_NEW");
    expect(vi.mocked(s.repo.storeRefreshedTokens).mock.calls[0]![0].expectedVersion).toBe(3);
    expect(s.state.creds!.tokenVersion).toBe(4);
    expect(decryptToken(s.state.creds!.encryptedRefreshToken!, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "refresh"))).toBe("shprt_NEW");
  });

  it("uses the winner's tokens when another process refreshed first", async () => {
    const s = setup();
    withCreds(s, { accessExpiresIn: 60_000 });
    const winner = encryptToken("shpat_WINNER", config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "access"));
    s.repo.storeRefreshedTokens = vi.fn(async () => {
      s.state.creds = { ...s.state.creds!, encryptedAccessToken: winner, tokenVersion: 4 };
      return false;
    });
    s.deps.fetch = shopifyFetch({ token: () => tokenResponse({ access_token: "shpat_LOSER" }) }) as unknown as typeof fetch;
    expect((await refreshTokenIfNeeded(STORE_ID, s.deps)).accessToken).toBe("shpat_WINNER");
  });

  it("marks needs_reconnect when the refresh token is rejected or expired", async () => {
    for (const variant of ["rejected", "expired"] as const) {
      const s = setup();
      withCreds(s, { accessExpiresIn: -1000, refreshExpiresIn: variant === "expired" ? -1000 : 86_400_000 });
      s.deps.fetch = shopifyFetch({ token: () => json({ error: "invalid_grant" }, 400) }) as unknown as typeof fetch;
      const err = await refreshTokenIfNeeded(STORE_ID, s.deps).catch((e) => e);
      expect(err.code).toBe("needs_reconnect");
      expect(s.state.verifications.at(-1)).toMatchObject({ ok: false, failureStatus: "needs_reconnect" });
    }
  });

  it("treats undecryptable credentials (rotated key / tampered row) as needs_reconnect", async () => {
    const s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    s.deps.config = { ...config, tokenEncryptionKey: Buffer.alloc(32, 7) };
    const err = await refreshTokenIfNeeded(STORE_ID, s.deps).catch((e) => e);
    expect(err.code).toBe("needs_reconnect");
  });
});

describe("verifyConnection", () => {
  it("401 → needs_reconnect; wrong shop → error; success → connected", async () => {
    let s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    s.deps.fetch = shopifyFetch({ graphql: () => json({}, 401) }) as unknown as typeof fetch;
    expect(await verifyConnection(STORE_ID, s.deps)).toMatchObject({ ok: false, code: "needs_reconnect", message: "Shopify needs to be reconnected." });

    s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    s.deps.fetch = shopifyFetch({ graphql: () => verifyResponse("other.myshopify.com") }) as unknown as typeof fetch;
    expect((await verifyConnection(STORE_ID, s.deps)).ok).toBe(false);
    expect(s.state.verifications.at(-1)).toMatchObject({ ok: false, failureStatus: "error" });

    s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    expect(await verifyConnection(STORE_ID, s.deps, { log: true })).toEqual({ ok: true, shopName: "Royal Sofa" });
    expect(s.state.verifications.at(-1)).toMatchObject({ ok: true, log: true });
  });

  it("not connected → friendly result, no throw", async () => {
    const s = setup();
    expect(await verifyConnection(STORE_ID, s.deps)).toMatchObject({ ok: false, code: "not_connected" });
  });
});

describe("disconnectStore", () => {
  it("revokes on Shopify (appUninstall) then removes local credentials", async () => {
    const s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    s.deps.fetch = shopifyFetch({ graphql: () => json({ data: { appUninstall: { userErrors: [] } } }) }) as unknown as typeof fetch;
    await disconnectStore(STORE_ID, USER_ID, s.deps);
    const body = JSON.parse(String((vi.mocked(s.deps.fetch).mock.calls[0]![1] as RequestInit).body));
    expect(body.query).toMatch(/appUninstall/);
    expect(s.repo.disconnect).toHaveBeenCalledWith(STORE_ID, USER_ID);
  });

  it("still disconnects locally when Shopify is unreachable or already uninstalled", async () => {
    const s = setup();
    withCreds(s, { accessExpiresIn: 30 * 60_000 });
    s.deps.fetch = shopifyFetch({ graphql: () => json({}, 401) }) as unknown as typeof fetch;
    await disconnectStore(STORE_ID, USER_ID, s.deps);
    expect(s.repo.disconnect).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
describe("webhooks", () => {
  const body = JSON.stringify({ id: 1, domain: SHOP });
  const sign = (b: string, secret = config.clientSecret) => createHmac("sha256", secret).update(b).digest("base64");
  const headers = (h: Record<string, string>) =>
    new Headers({ "x-shopify-topic": "app/uninstalled", "x-shopify-shop-domain": SHOP, "x-shopify-webhook-id": "wh-1", ...h });

  it("app/uninstalled with valid HMAC is processed", async () => {
    const { repo } = fakeRepo();
    const r = await handleShopifyWebhook({ rawBody: body, headers: headers({ "x-shopify-hmac-sha256": sign(body) }) }, { clientSecret: config.clientSecret, repo });
    expect(r).toEqual({ status: 200, outcome: "disconnected" });
    expect(repo.handleAppUninstalled).toHaveBeenCalledWith("wh-1", SHOP);
  });

  it("invalid / missing HMAC → 401 and nothing processed", async () => {
    const { repo } = fakeRepo();
    for (const h of [sign(body, "wrong"), sign(body + " "), "", "not base64!"]) {
      const r = await handleShopifyWebhook({ rawBody: body, headers: headers(h ? { "x-shopify-hmac-sha256": h } : {}) }, { clientSecret: config.clientSecret, repo });
      expect(r.status).toBe(401);
    }
    expect(repo.handleAppUninstalled).not.toHaveBeenCalled();
    expect(repo.recordWebhook).not.toHaveBeenCalled();
  });

  it("duplicates are acknowledged without reprocessing", async () => {
    const { repo } = fakeRepo({ handleAppUninstalled: vi.fn(async () => "duplicate") });
    const r = await handleShopifyWebhook({ rawBody: body, headers: headers({ "x-shopify-hmac-sha256": sign(body) }) }, { clientSecret: config.clientSecret, repo });
    expect(r).toEqual({ status: 200, outcome: "duplicate" });
  });

  it("shop/redact → 200 via the erase function (Prompt 14F)", async () => {
    const { repo } = fakeRepo();
    const r = await handleShopifyWebhook(
      { rawBody: body, headers: headers({ "x-shopify-topic": "shop/redact", "x-shopify-hmac-sha256": sign(body) }) },
      { clientSecret: config.clientSecret, repo },
    );
    expect(r).toEqual({ status: 200, outcome: "shop_redact:redacted" });
    expect(repo.handleShopRedact).toHaveBeenCalledWith("wh-1", SHOP);
  });

  it.each(["customers/data_request", "customers/redact"])("compliance topic %s → 200", async (topic) => {
    const { repo } = fakeRepo();
    const r = await handleShopifyWebhook(
      { rawBody: body, headers: headers({ "x-shopify-topic": topic, "x-shopify-hmac-sha256": sign(body) }) },
      { clientSecret: config.clientSecret, repo },
    );
    expect(r.status).toBe(200);
    expect(repo.recordWebhook).toHaveBeenCalledWith("wh-1", topic, SHOP);
  });

  it("malformed shop → 400; DB failure → 500 (Shopify retries)", async () => {
    const { repo } = fakeRepo({ handleAppUninstalled: vi.fn(async () => { throw new Error("db down"); }) });
    const bad = await handleShopifyWebhook({ rawBody: body, headers: headers({ "x-shopify-shop-domain": "evil.com", "x-shopify-hmac-sha256": sign(body) }) }, { clientSecret: config.clientSecret, repo });
    expect(bad.status).toBe(400);
    const down = await handleShopifyWebhook({ rawBody: body, headers: headers({ "x-shopify-hmac-sha256": sign(body) }) }, { clientSecret: config.clientSecret, repo });
    expect(down.status).toBe(500);
  });
});
