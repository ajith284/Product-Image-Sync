import type { NextConfig } from "next";

/**
 * Security headers for every route (Prompt 14F).
 *
 * CSP is deliberately limited to directives that cannot break scripts, styles or the
 * Shopify / Google OAuth redirects: no framing (clickjacking), no <base> hijacking, no
 * plugins. A script-src / style-src policy needs per-request nonces generated in proxy.ts
 * and dynamic rendering of every page (Next.js 16 CSP guide) — deferred to a dedicated
 * frontend audit rather than shipping a policy that could break the app. `form-action` is
 * also left out on purpose: Chrome applies it to the redirect that follows a form
 * submission, which is how the Connect buttons reach Shopify / Google.
 */
export const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // OAuth uses full-page redirects (no popups), so the app never needs a cross-origin opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HTTPS-only in production (no preload; browsers ignore HSTS on http://localhost anyway).
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Hostnames (other than localhost) this app is opened on — e.g. the https
 * tunnel used for Shopify during development. Taken from the app's own URL
 * settings plus an optional comma-separated ALLOWED_DEV_ORIGINS list.
 *
 * Why: Next.js 16's dev server blocks its client scripts for any hostname other
 * than localhost unless it is listed in `allowedDevOrigins`. Without this, pages
 * render but client-side buttons (e.g. the Add Store wizard's "Continue") do nothing.
 */
const appHosts = [
  hostnameOf(process.env.SHOPIFY_APP_URL),
  hostnameOf(process.env.NEXT_PUBLIC_SITE_URL),
  ...(process.env.ALLOWED_DEV_ORIGINS ?? "").split(","),
]
  .map((h) => h?.trim().toLowerCase())
  .filter((h): h is string => Boolean(h) && h !== "localhost");

const uniqueHosts = [...new Set(appHosts)];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Development only: let the dev server serve its scripts to these hosts.
  allowedDevOrigins: [...new Set(["127.0.0.1", ...uniqueHosts])],
  experimental: {
    serverActions: {
      // Server Actions (forms/buttons) are accepted from the app's own configured
      // hosts even when a tunnel/proxy forwards a different Host header.
      allowedOrigins: uniqueHosts,
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;