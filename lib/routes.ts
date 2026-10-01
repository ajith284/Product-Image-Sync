export const DEFAULT_AUTHENTICATED_PATH = "/dashboard";
export const LOGIN_PATH = "/login";

/** Paths reachable without a session. */
const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/auth",
  // Shopify webhooks carry no user session; they are authenticated by HMAC.
  "/api/shopify/webhooks",
  // Machine API for n8n: authenticated ONLY by API key (never by a browser session).
  "/api/n8n",
];

/** Pages a signed-in user should be sent away from. */
const GUEST_ONLY_PREFIXES = ["/login", "/signup"];

function matches(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * JSON API routes: a signed-out request gets 401 JSON instead of a redirect to
 * the login page. (The Shopify OAuth callback is a browser redirect target and
 * keeps the normal login redirect.)
 */
const JSON_API_PREFIXES = ["/api/shopify/products", "/api/google/folders"];

export const isJsonApiPath = (pathname: string) => matches(pathname, JSON_API_PREFIXES);

export const isPublicPath = (pathname: string) => matches(pathname, PUBLIC_PREFIXES);
export const isGuestOnlyPath = (pathname: string) =>
  matches(pathname, GUEST_ONLY_PREFIXES);

/**
 * Only allow same-origin relative redirects (prevents open redirects via ?next=).
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return DEFAULT_AUTHENTICATED_PATH;
  }
  return next;
}
