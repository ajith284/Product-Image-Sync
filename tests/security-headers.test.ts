import { afterEach, describe, expect, it, vi } from "vitest";

/** Prompt 14F — security headers from next.config.ts (applied to every route). */

async function load(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", nodeEnv);
  const mod = await import("@/next.config");
  const rules = await mod.default.headers!();
  return {
    rules,
    headers: Object.fromEntries(rules[0]!.headers.map((h) => [h.key, h.value])),
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("security headers", () => {
  it("apply to every path", async () => {
    const { rules } = await load("development");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
  });

  it("frame protection: CSP frame-ancestors 'none' + X-Frame-Options DENY", async () => {
    const { headers } = await load("development");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("CSP blocks <base> hijacking and plugins, but does NOT restrict scripts/styles/forms (deferred, would break Next.js / OAuth)", async () => {
    const csp = (await load("production")).headers["Content-Security-Policy"]!;
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    for (const d of [
      "script-src",
      "style-src",
      "default-src",
      "form-action",
      "connect-src",
    ])
      expect(csp).not.toContain(d);
  });

  it("nosniff, referrer policy, permissions policy, COOP", async () => {
    const { headers } = await load("development");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("HSTS only in production, without preload", async () => {
    expect(
      (await load("development")).headers["Strict-Transport-Security"],
    ).toBeUndefined();
    const hsts = (await load("production")).headers[
      "Strict-Transport-Security"
    ];
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("no header leaks configuration values", async () => {
    vi.stubEnv("SHOPIFY_CLIENT_SECRET", "shpss_SECRET_HEADER_TEST");
    const { rules } = await load("production");
    expect(JSON.stringify(rules)).not.toContain("SECRET");
  });
});
