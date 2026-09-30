import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createShopifyClient, ShopifyApiError } from "@/lib/shopify/client";
import { buildAuthorizeUrl, createOAuthState, hashOAuthState, verifyShopifyHmac } from "@/lib/shopify/oauth";
import type { ShopDomain } from "@/lib/shopify/types";

const SHOP = "my-store.myshopify.com" as ShopDomain;
const SECRET = "test-secret";

describe("OAuth preparation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("creates random state and stores only its hash", () => {
    const a = createOAuthState();
    const b = createOAuthState();
    expect(a.state).not.toBe(b.state);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.stateHash).toBe(hashOAuthState(a.state));
    expect(a.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.stateHash).not.toContain(a.state);
  });

  it("builds the authorize URL from config (offline access, minimum scopes)", () => {
    vi.stubEnv("SHOPIFY_CLIENT_ID", "cid");
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", SECRET);
    vi.stubEnv("SHOPIFY_APP_URL", "http://localhost:3000");
    vi.stubEnv("SHOPIFY_SCOPES", "read_products,write_products,write_files");
    vi.stubEnv("SHOPIFY_API_VERSION", "2026-07");
    vi.stubEnv("SHOPIFY_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
    const url = new URL(buildAuthorizeUrl({ shop: SHOP, state: "abc" }));
    expect(url.origin + url.pathname).toBe("https://my-store.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("read_products,write_products,write_files");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/shopify/callback");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.has("grant_options[]")).toBe(false);
    expect(url.toString()).not.toContain(SECRET);
  });

  it("verifies Shopify callback HMAC and rejects tampering", () => {
    const params = new URLSearchParams({ code: "c0de", shop: SHOP, state: "s", timestamp: "1790000000" });
    const message = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    params.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));

    expect(verifyShopifyHmac(params, SECRET)).toBe(true);
    expect(verifyShopifyHmac(params, "wrong-secret")).toBe(false);

    const tampered = new URLSearchParams(params);
    tampered.set("shop", "evil-store.myshopify.com");
    expect(verifyShopifyHmac(tampered, SECRET)).toBe(false);

    const noHmac = new URLSearchParams(params);
    noHmac.delete("hmac");
    expect(verifyShopifyHmac(noHmac, SECRET)).toBe(false);

    const junk = new URLSearchParams(params);
    junk.set("hmac", "zz");
    expect(verifyShopifyHmac(junk, SECRET)).toBe(false);
  });
});

describe("createShopifyClient (no real API calls)", () => {
  const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers }));

  it("rejects unvalidated shop domains", () => {
    expect(() => createShopifyClient({ shop: "evil.com", accessToken: "t", apiVersion: "2026-07" })).toThrow();
    expect(() => createShopifyClient({ shop: "https://my-store.myshopify.com", accessToken: "t", apiVersion: "2026-07" })).toThrow();
  });

  it("posts to the versioned GraphQL endpoint with the token header", async () => {
    const fetchMock = ok({ data: { shop: { name: "My Store" } } });
    const client = createShopifyClient({ shop: SHOP, accessToken: "shpat_test", apiVersion: "2026-07", fetch: fetchMock });
    const res = await client.graphql<{ shop: { name: string } }>("{ shop { name } }");
    expect(res.data.shop.name).toBe("My Store");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://my-store.myshopify.com/admin/api/2026-07/graphql.json");
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_test");
  });

  it.each([
    [401, "unauthorized", "Shopify needs to be reconnected."],
    [402, "payment_required", undefined],
    [404, "not_found", undefined],
    [429, "throttled", undefined],
    [503, "unavailable", undefined],
  ])("maps HTTP %i → %s without leaking the token", async (status, kind, message) => {
    const client = createShopifyClient({ shop: SHOP, accessToken: "shpat_secret_token", apiVersion: "2026-07", fetch: ok({}, status, { "Retry-After": "2" }) });
    const err = await client.graphql("{ shop { name } }").catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err.kind).toBe(kind);
    if (message) expect(err.userMessage).toBe(message);
    expect(err.message).not.toContain("shpat_secret_token");
  });

  it("detects GraphQL THROTTLED errors", async () => {
    const client = createShopifyClient({
      shop: SHOP,
      accessToken: "t",
      apiVersion: "2026-07",
      fetch: ok({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
    });
    const err = await client.graphql("{ shop { name } }").catch((e) => e);
    expect(err.kind).toBe("throttled");
    expect(err.retryable).toBe(true);
  });

  it("maps network failures", async () => {
    const client = createShopifyClient({
      shop: SHOP,
      accessToken: "t",
      apiVersion: "2026-07",
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    const err = await client.graphql("{ shop { name } }").catch((e) => e);
    expect(err.kind).toBe("network");
  });
});
