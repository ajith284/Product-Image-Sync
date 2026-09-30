import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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