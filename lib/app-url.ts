import "server-only";

import { NextResponse } from "next/server";

/**
 * The app's trusted public base URL for absolute redirects (OAuth callbacks,
 * email links). It comes ONLY from server configuration — never from the
 * request (Host / X-Forwarded-* headers) and never from user input:
 *
 *   1. NEXT_PUBLIC_SITE_URL                      (e.g. https://reach-rental-heat.ngrok-free.dev)
 *   2. the provider's own configured callback origin (SHOPIFY_APP_URL / GOOGLE_REDIRECT_URI)
 *   3. none → a RELATIVE Location ("/stores/…"), which the browser resolves
 *      against the URL it is actually on.
 *
 * Why: behind a tunnel (ngrok) Next's dev server builds request.url from its
 * own host plus X-Forwarded-Proto, i.e. "https://localhost:3000" — a URL that
 * doesn't exist (ERR_SSL_PROTOCOL_ERROR).
 *
 * Rules: local hosts (localhost, 127.0.0.1, [::1], *.localhost) are always
 * http://; other hosts must be https:// in production. Only the origin is used.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLocalHost = (hostname: string) => LOCAL_HOSTS.has(hostname) || hostname.endsWith(".localhost");

/** Returns a safe origin ("https://host[:port]") or null when the value isn't usable. */
export function normalizeBaseUrl(value: string | null | undefined, isProduction: boolean): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isLocalHost(url.hostname)) {
    // The local dev server speaks plain HTTP: never generate https://localhost.
    if (isProduction) return null;
    return `http://${url.host}`;
  }
  if (isProduction && url.protocol !== "https:") return null;
  return url.origin;
}

export type BaseUrlSource = { name: string; value: string | null | undefined };

let warned = false;

/**
 * First usable configured base URL, or null. `fallbacks` are the provider's
 * own configured URLs (only used when NEXT_PUBLIC_SITE_URL is missing/invalid).
 */
export function getAppBaseUrl(
  fallbacks: BaseUrlSource[] = [],
  env: { NEXT_PUBLIC_SITE_URL?: string; NODE_ENV?: string } = process.env,
): string | null {
  const isProduction = env.NODE_ENV === "production";
  const site = normalizeBaseUrl(env.NEXT_PUBLIC_SITE_URL, isProduction);

  if (!isProduction && site && !warned) {
    for (const f of fallbacks) {
      const other = normalizeBaseUrl(f.value, isProduction);
      if (other && other !== site) {
        warned = true;
        // Origins aren't secret. A mismatch sends users to a host without their session cookie.
        console.warn(
          `[app-url] NEXT_PUBLIC_SITE_URL (${site}) differs from ${f.name} (${other}). ` +
            "Use the same public URL for both, or users may be asked to sign in again after connecting.",
        );
        break;
      }
    }
  }
  if (site) return site;

  for (const f of fallbacks) {
    const base = normalizeBaseUrl(f.value, isProduction);
    if (base) return base;
  }
  return null;
}

/** Only server-built, same-app paths: "/stores/…", never "//evil" or "https://…". */
export function isSafeAppPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") && !/[\r\n]/.test(path);
}

/**
 * 307 redirect to a path of this app on the configured base URL (or a relative
 * Location when none is configured). Never cached, no Referer leakage.
 */
export function appRedirect(path: string, fallbacks: BaseUrlSource[] = []): NextResponse {
  if (!isSafeAppPath(path)) throw new Error("appRedirect: path must be an app-relative path");
  const base = getAppBaseUrl(fallbacks);
  const location = base ? `${base}${path}` : path;
  return new NextResponse(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
