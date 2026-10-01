import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appRedirect, getAppBaseUrl, isSafeAppPath, normalizeBaseUrl } from "@/lib/app-url";

const NGROK = "https://reach-rental-heat.ngrok-free.dev";

describe("normalizeBaseUrl", () => {
  it.each([
    [NGROK, false, NGROK],
    [`${NGROK}/`, false, NGROK],
    [`${NGROK}/some/path?x=1`, false, NGROK],
    ["https://app.example.com", true, "https://app.example.com"],
    ["http://localhost:3000", false, "http://localhost:3000"],
    // the bug: https://localhost is never produced
    ["https://localhost:3000", false, "http://localhost:3000"],
    ["https://127.0.0.1:3000", false, "http://127.0.0.1:3000"],
    ["http://192.168.1.20:3000", false, "http://192.168.1.20:3000"],
  ])("%s (production=%s) → %s", (input, prod, expected) => {
    expect(normalizeBaseUrl(input, prod)).toBe(expected);
  });

  it.each([
    ["", false],
    ["not a url", false],
    ["javascript:alert(1)", false],
    ["ftp://example.com", false],
    ["https://user:pass@example.com", false],
    ["http://app.example.com", true], // production must be https
    ["http://localhost:3000", true], // no localhost in production
  ])("rejects %j (production=%s)", (input, prod) => {
    expect(normalizeBaseUrl(input, prod)).toBeNull();
  });
});

describe("getAppBaseUrl", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("prefers NEXT_PUBLIC_SITE_URL", () => {
    expect(
      getAppBaseUrl([{ name: "SHOPIFY_APP_URL", value: "https://other.example.com" }], {
        NEXT_PUBLIC_SITE_URL: NGROK,
        NODE_ENV: "development",
      }),
    ).toBe(NGROK);
  });

  it("falls back to the provider's configured URL, then null (relative redirect)", () => {
    expect(getAppBaseUrl([{ name: "GOOGLE_REDIRECT_URI", value: `${NGROK}/api/google/callback` }], { NODE_ENV: "development" })).toBe(NGROK);
    expect(getAppBaseUrl([], { NODE_ENV: "development" })).toBeNull();
    expect(getAppBaseUrl([{ name: "X", value: "garbage" }], { NEXT_PUBLIC_SITE_URL: "garbage", NODE_ENV: "development" })).toBeNull();
  });

  it("production ignores non-https values", () => {
    expect(getAppBaseUrl([{ name: "SHOPIFY_APP_URL", value: "https://shop-app.example.com" }], {
      NEXT_PUBLIC_SITE_URL: "http://insecure.example.com",
      NODE_ENV: "production",
    })).toBe("https://shop-app.example.com");
  });
});

describe("appRedirect", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("absolute URL on the configured site; no-store; no referrer", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", NGROK);
    const res = appRedirect("/stores/abc?google=connected");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${NGROK}/stores/abc?google=connected`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("no configured URL → relative Location (browser stays on the host it is on)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(appRedirect("/stores?x=1").headers.get("location")).toBe("/stores?x=1");
  });

  it.each(["//evil.example.com", "/\\evil.example.com", "https://evil.example.com", "stores", "/x\r\nSet-Cookie: a=b"])(
    "refuses non-app paths (open redirect): %j",
    (path) => {
      expect(isSafeAppPath(path)).toBe(false);
      expect(() => appRedirect(path)).toThrow(/app-relative path/);
    },
  );
});

// ---------------------------------------------------------------------------
// Route regressions: Shopify callback + email confirm use the same helper.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  handleCallback: vi.fn(),
  exchange: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/auth", () => ({ getSessionUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/shopify/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shopify/runtime")>()),
  getShopifyDeps: vi.fn(() => ({})),
}));
vi.mock("@/lib/shopify/auth", () => ({ handleCallback: mocks.handleCallback }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { exchangeCodeForSession: mocks.exchange, verifyOtp: mocks.exchange } })),
}));

const shopifyRoute = await import("@/app/api/shopify/callback/route");
const confirmRoute = await import("@/app/auth/confirm/route");
const { ShopifyFlowError } = await import("@/lib/shopify/errors");

/** Exactly what Next's dev server hands the route behind ngrok. */
const behindNgrok = (path: string) =>
  new NextRequest(`https://localhost:3000${path}`, {
    headers: { host: "reach-rental-heat.ngrok-free.dev", "x-forwarded-proto": "https" },
  });

describe("Shopify callback redirect (regression)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", NGROK);
    vi.stubEnv("SHOPIFY_APP_URL", NGROK);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("success → configured site URL, never https://localhost", async () => {
    mocks.handleCallback.mockResolvedValueOnce({ storeId: "s1", verified: true });
    const res = await shopifyRoute.GET(behindNgrok("/api/shopify/callback?code=c&shop=x.myshopify.com"));
    expect(res.headers.get("location")).toBe(`${NGROK}/stores/s1?shopify=connected`);
    expect(res.headers.get("location")).not.toContain("localhost");
  });

  it("error → configured site URL with the error code", async () => {
    mocks.handleCallback.mockRejectedValueOnce(new ShopifyFlowError("invalid_hmac", { storeId: "s1" }));
    const res = await shopifyRoute.GET(behindNgrok("/api/shopify/callback?code=c"));
    expect(res.headers.get("location")).toBe(`${NGROK}/stores/s1?shopify_error=invalid_hmac`);
  });

  it("without NEXT_PUBLIC_SITE_URL → SHOPIFY_APP_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    mocks.handleCallback.mockResolvedValueOnce({ storeId: "s1", verified: false });
    const res = await shopifyRoute.GET(behindNgrok("/api/shopify/callback?code=c"));
    expect(res.headers.get("location")).toBe(`${NGROK}/stores/s1?shopify=connected_unverified`);
  });
});

describe("Email confirm redirect (same root cause)", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SITE_URL", NGROK));
  afterEach(() => vi.unstubAllEnvs());

  it("goes to the configured site; ?next= stays a safe app path", async () => {
    let res = await confirmRoute.GET(behindNgrok("/auth/confirm?code=abc&next=/stores"));
    expect(res.headers.get("location")).toBe(`${NGROK}/stores`);
    res = await confirmRoute.GET(behindNgrok("/auth/confirm?code=abc&next=//evil.example.com"));
    expect(res.headers.get("location")).toBe(`${NGROK}/dashboard`);
  });
});
