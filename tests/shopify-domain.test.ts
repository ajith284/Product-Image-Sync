import { describe, expect, it } from "vitest";

import { isValidShopDomain, normalizeShopDomain, verifyShopDomain } from "@/lib/shopify/domain";
import { storeInfoSchema } from "@/lib/validation/store";

describe("normalizeShopDomain — valid input", () => {
  it.each([
    ["my-store.myshopify.com", "my-store.myshopify.com"],
    ["https://my-store.myshopify.com", "my-store.myshopify.com"],
    ["http://my-store.myshopify.com", "my-store.myshopify.com"],
    ["  HTTPS://My-Store.MyShopify.com/admin/products  ", "my-store.myshopify.com"],
    ["my-store.myshopify.com/", "my-store.myshopify.com"],
    ["my-store.myshopify.com.", "my-store.myshopify.com"],
    ["my-store", "my-store.myshopify.com"],
    ["https://admin.shopify.com/store/my-store/products", "my-store.myshopify.com"],
    ["store123.myshopify.com", "store123.myshopify.com"],
    // Reported live input (handle with digits and a hyphen)
    ["psvft1-0d.myshopify.com", "psvft1-0d.myshopify.com"],
    [" https://PSVFT1-0D.myshopify.com/ ", "psvft1-0d.myshopify.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeShopDomain(input)).toBe(expected);
  });
});

describe("normalizeShopDomain — rejected input", () => {
  it.each([
    "example.com",
    "https://example.com",
    "javascript:test",
    "javascript:alert(1)",
    "JAVASCRIPT://my-store.myshopify.com",
    "data:text/html,<script>alert(1)</script>",
    "ftp://my-store.myshopify.com",
    "my-store.myshopify.com.evil.com",
    "https://my-store.myshopify.com.evil.com/",
    "evil.com/my-store.myshopify.com",
    "https://evil.com?x=my-store.myshopify.com",
    "https://user:pass@my-store.myshopify.com",
    "https://my-store.myshopify.com:8443",
    "my-store.myshopify.com:443",
    "sub.my-store.myshopify.com",
    "-store.myshopify.com",
    "my_store.myshopify.com",
    "my store.myshopify.com",
    "my-store.myshopify.com\n.evil.com",
    "mу-store.myshopify.com", // Cyrillic "у"
    "https://admin.shopify.com/settings",
    "myshopify.com",
    "",
    "   ",
    "a".repeat(300),
  ])("rejects %j", (input) => {
    expect(normalizeShopDomain(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeShopDomain(undefined)).toBeNull();
    expect(normalizeShopDomain(null)).toBeNull();
    expect(normalizeShopDomain(123)).toBeNull();
    expect(normalizeShopDomain({ toString: () => "my-store.myshopify.com" })).toBeNull();
  });
});

describe("verifyShopDomain / isValidShopDomain", () => {
  it("verify returns normalized domain", () => {
    expect(verifyShopDomain("https://my-store.myshopify.com")).toBe("my-store.myshopify.com");
  });
  it("verify throws a friendly error", () => {
    expect(() => verifyShopDomain("example.com")).toThrow(/myshopify\.com address/);
  });
  it("isValidShopDomain is strict (no normalization)", () => {
    expect(isValidShopDomain("my-store.myshopify.com")).toBe(true);
    expect(isValidShopDomain("https://my-store.myshopify.com")).toBe(false);
    expect(isValidShopDomain("My-Store.myshopify.com")).toBe(false);
  });
});

describe("Add Store form schema uses the same validator", () => {
  it("normalizes", () => {
    const r = storeInfoSchema.safeParse({ name: "Royal", shopifyDomain: "https://Royal-Sofa.myshopify.com" });
    expect(r.success && r.data.shopifyDomain).toBe("royal-sofa.myshopify.com");
  });
  it("rejects", () => {
    expect(storeInfoSchema.safeParse({ name: "Royal", shopifyDomain: "example.com" }).success).toBe(false);
  });
});
