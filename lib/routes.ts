export const DEFAULT_AUTHENTICATED_PATH = "/dashboard";
export const LOGIN_PATH = "/login";

/** Paths reachable without a session. */
const PUBLIC_PREFIXES = ["/login", "/signup", "/auth"];

/** Pages a signed-in user should be sent away from. */
const GUEST_ONLY_PREFIXES = ["/login", "/signup"];

function matches(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

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
