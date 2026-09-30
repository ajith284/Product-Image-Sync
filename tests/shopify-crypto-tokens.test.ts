import { describe, expect, it, vi } from "vitest";

import { decryptToken, encryptToken, tokenContext, TokenDecryptionError } from "@/lib/shopify/crypto";
import { exchangeToken, refreshAccessToken } from "@/lib/shopify/tokens";
import type { ShopDomain } from "@/lib/shopify/types";

import { config, json, NOW, SHOP, tokenResponse } from "./helpers/shopify-fakes";

const KEY = Buffer.alloc(32, 1);
const CTX = tokenContext("store-a", SHOP, "access");

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptToken("shpat_secret", KEY, CTX);
    const b = encryptToken("shpat_secret", KEY, CTX);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a).not.toContain("shpat_secret");
    expect(decryptToken(a, KEY, CTX)).toBe("shpat_secret");
  });

  it("rejects tampering, wrong key and wrong context (row / token kind swap)", () => {
    const enc = encryptToken("shpat_secret", KEY, CTX);
    const parts = enc.split(".");
    const flipped = parts[2]!.startsWith("A") ? "B" + parts[2]!.slice(1) : "A" + parts[2]!.slice(1);
    expect(() => decryptToken([parts[0], parts[1], flipped, parts[3]].join("."), KEY, CTX)).toThrow(TokenDecryptionError);
    expect(() => decryptToken(enc, Buffer.alloc(32, 2), CTX)).toThrow(TokenDecryptionError);
    expect(() => decryptToken(enc, KEY, tokenContext("store-b", SHOP, "access"))).toThrow(TokenDecryptionError);
    expect(() => decryptToken(enc, KEY, tokenContext("store-a", SHOP, "refresh"))).toThrow(TokenDecryptionError);
    expect(() => decryptToken("plaintext-token", KEY, CTX)).toThrow(TokenDecryptionError);
  });

  it("refuses bad keys", () => {
    expect(() => encryptToken("x", Buffer.alloc(16), CTX)).toThrow();
  });
});

describe("exchangeToken", () => {
  it("POSTs form params with expiring=1 and parses expiries", async () => {
    const fetchMock = vi.fn(async () => tokenResponse());
    const t = await exchangeToken(SHOP as ShopDomain, "the-code", config, fetchMock, NOW);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: "test-client-id",
      client_secret: "test-client-secret",
      code: "the-code",
      expiring: "1",
    });
    expect(t.accessToken).toBe("shpat_ACCESS_SECRET_1");
    expect(t.refreshToken).toBe("shprt_REFRESH_SECRET_1");
    expect(t.accessExpiresAt?.getTime()).toBe(NOW + 3600_000);
    expect(t.refreshExpiresAt?.getTime()).toBe(NOW + 7_776_000_000);
  });

  it("fails closed without leaking anything", async () => {
    for (const res of [json({ error: "invalid_request" }, 400), json({}, 200), json({ access_token: "" }, 200)]) {
      const err = await exchangeToken(SHOP as ShopDomain, "c", config, vi.fn(async () => res), NOW).catch((e) => e);
      expect(err.code).toBe("exchange_failed");
      expect(String(err.message)).not.toContain(config.clientSecret);
    }
    const net = await exchangeToken(SHOP as ShopDomain, "c", config, vi.fn(async () => { throw new TypeError("fetch failed"); }), NOW).catch((e) => e);
    expect(net.code).toBe("exchange_failed");
  });
});

describe("refreshAccessToken", () => {
  it("uses grant_type=refresh_token", async () => {
    const fetchMock = vi.fn(async () => tokenResponse({ access_token: "shpat_NEW", refresh_token: "shprt_NEW" }));
    const r = await refreshAccessToken(SHOP as ShopDomain, "shprt_OLD", config, fetchMock, NOW);
    const body = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("shprt_OLD");
    expect(r.ok && r.tokens.accessToken).toBe("shpat_NEW");
  });

  it("distinguishes rejected (reconnect) from unavailable (retry)", async () => {
    expect(await refreshAccessToken(SHOP as ShopDomain, "x", config, vi.fn(async () => json({}, 401)), NOW)).toEqual({ ok: false, reason: "rejected" });
    expect(await refreshAccessToken(SHOP as ShopDomain, "x", config, vi.fn(async () => json({}, 503)), NOW)).toEqual({ ok: false, reason: "unavailable" });
    expect(await refreshAccessToken(SHOP as ShopDomain, "x", config, vi.fn(async () => { throw new Error("net"); }), NOW)).toEqual({ ok: false, reason: "unavailable" });
  });
});
