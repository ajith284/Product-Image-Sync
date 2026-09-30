import { describe, expect, it } from "vitest";

import { getShopifyConfig, getShopifyConfigStatus, ShopifyConfigError } from "@/lib/shopify/config";
import { hasRequiredScopes } from "@/lib/shopify/scopes";

// Fake, non-secret test values.
const KEY = Buffer.alloc(32, 7).toString("base64");
const valid = {
  SHOPIFY_CLIENT_ID: "test-client-id",
  SHOPIFY_CLIENT_SECRET: "test-client-secret-VALUE",
  SHOPIFY_APP_URL: "http://localhost:3000/",
  SHOPIFY_SCOPES: "read_products, write_products,write_files",
  SHOPIFY_API_VERSION: "2026-07",
  SHOPIFY_TOKEN_ENCRYPTION_KEY: KEY,
};

describe("getShopifyConfig", () => {
  it("parses a valid development config", () => {
    const c = getShopifyConfig(valid, false);
    expect(c.appUrl).toBe("http://localhost:3000");
    expect(c.redirectUri).toBe("http://localhost:3000/api/shopify/callback");
    expect(c.scopes).toEqual(["read_products", "write_products", "write_files"]);
    expect(c.tokenEncryptionKey.length).toBe(32);
  });

  it("lists every missing variable by name", () => {
    try {
      getShopifyConfig({}, false);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ShopifyConfigError);
      const err = e as ShopifyConfigError;
      expect(err.missing).toEqual([
        "SHOPIFY_CLIENT_ID",
        "SHOPIFY_CLIENT_SECRET",
        "SHOPIFY_APP_URL",
        "SHOPIFY_SCOPES",
        "SHOPIFY_API_VERSION",
        "SHOPIFY_TOKEN_ENCRYPTION_KEY",
      ]);
      expect(err.message).toMatch(/Shopify is not configured: missing SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET/);
      expect(err.message).toMatch(/docs\/shopify-setup\.md/);
    }
  });

  it("treats blank values as missing", () => {
    const s = getShopifyConfigStatus({ ...valid, SHOPIFY_CLIENT_SECRET: "   " }, false);
    expect(s).toEqual({ configured: false, missing: ["SHOPIFY_CLIENT_SECRET"], invalid: [] });
  });

  it("never includes secret values in error messages", () => {
    const secret = "super-secret-value-123";
    try {
      getShopifyConfig({ ...valid, SHOPIFY_CLIENT_SECRET: secret, SHOPIFY_TOKEN_ENCRYPTION_KEY: "not-a-key!" }, false);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
      expect(String((e as Error).message)).not.toContain("not-a-key!");
      expect((e as ShopifyConfigError).invalid.join()).toMatch(/SHOPIFY_TOKEN_ENCRYPTION_KEY/);
    }
  });

  it.each([
    ["SHOPIFY_SCOPES", "read_products,write_products,write_files,read_orders"],
    ["SHOPIFY_SCOPES", "read_products,write_products"],
    ["SHOPIFY_SCOPES", "read_customers"],
    ["SHOPIFY_API_VERSION", "unstable"],
    ["SHOPIFY_API_VERSION", "2026-06"],
    ["SHOPIFY_APP_URL", "not a url"],
    ["SHOPIFY_APP_URL", "javascript:alert(1)"],
    ["SHOPIFY_APP_URL", "http://example.com"],
    ["SHOPIFY_APP_URL", "https://app.example.com?x=1"],
    ["SHOPIFY_TOKEN_ENCRYPTION_KEY", Buffer.alloc(16).toString("base64")],
  ])("rejects invalid %s=%s", (name, value) => {
    const s = getShopifyConfigStatus({ ...valid, [name]: value }, false);
    expect(s.configured).toBe(false);
    expect(s.invalid).toEqual([name]);
  });

  it("requires https in production", () => {
    expect(getShopifyConfigStatus(valid, true).invalid).toEqual(["SHOPIFY_APP_URL"]);
    expect(getShopifyConfigStatus({ ...valid, SHOPIFY_APP_URL: "https://app.example.com" }, true).configured).toBe(true);
  });
});

describe("hasRequiredScopes", () => {
  it("accepts exact and implied read scopes", () => {
    expect(hasRequiredScopes("read_products,write_products,write_files")).toBe(true);
    expect(hasRequiredScopes("write_products,write_files")).toBe(true); // write implies read
  });
  it("rejects missing scopes", () => {
    expect(hasRequiredScopes("read_products,write_products")).toBe(false);
    expect(hasRequiredScopes("")).toBe(false);
  });
});
