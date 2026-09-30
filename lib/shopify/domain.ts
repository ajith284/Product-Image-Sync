/**
 * Shopify shop-domain validation. Pure and dependency-free, so it is safe to use
 * in both server code and client components (the Add Store wizard).
 *
 * Never trust a user-provided domain: always pass it through normalizeShopDomain()
 * (user input) or isValidShopDomain() (values Shopify sends back, e.g. `shop`
 * on the OAuth callback) before using it in a URL or query.
 */

/** Shopify's documented pattern, anchored at both ends; lowercased. */
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_INPUT_LENGTH = 255;

export type ShopDomain = string & { readonly __brand: "ShopDomain" };

export class InvalidShopDomainError extends Error {
  constructor() {
    super("Enter your store's myshopify.com address, e.g. royal-sofa.myshopify.com");
    this.name = "InvalidShopDomainError";
  }
}

/** Strict check for an already-normalized value (e.g. the `shop` param Shopify sends). */
export function isValidShopDomain(value: unknown): value is ShopDomain {
  return typeof value === "string" && SHOP_DOMAIN_RE.test(value);
}

function hostFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.replace(/\.$/, "");

  // Shopify admin URL: https://admin.shopify.com/store/<handle>/...
  if (host === "admin.shopify.com") {
    const handle = url.pathname.split("/")[2] ?? "";
    return url.pathname.startsWith("/store/") && HANDLE_RE.test(handle) ? `${handle}.myshopify.com` : null;
  }
  return host;
}

/**
 * Normalizes user input to `store-name.myshopify.com`, or returns null.
 *
 * Accepts: `store-name.myshopify.com`, `https://store-name.myshopify.com[/admin…]`,
 * `https://admin.shopify.com/store/store-name`, or the bare handle `store-name`.
 * Rejects: other domains (incl. custom storefront domains), non-http(s) schemes
 * (`javascript:`, `data:` …), credentials, ports, whitespace/control/non-ASCII
 * characters, and look-alikes such as `store.myshopify.com.evil.com`.
 */
export function normalizeShopDomain(input: unknown): ShopDomain | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > MAX_INPUT_LENGTH) return null;
  // Printable ASCII only, no inner whitespace.
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;

  let host: string | null;
  if (raw.includes("://")) {
    host = hostFromUrl(raw);
  } else if (raw.includes(":")) {
    // "javascript:alert(1)", "store.myshopify.com:443", "mailto:x" …
    return null;
  } else if (raw.includes("/")) {
    host = hostFromUrl(`https://${raw}`);
  } else {
    host = raw.replace(/\.$/, "");
    if (!host.includes(".")) host = HANDLE_RE.test(host) ? `${host}.myshopify.com` : null;
  }

  return isValidShopDomain(host) ? host : null;
}

/** Like normalizeShopDomain() but throws InvalidShopDomainError. */
export function verifyShopDomain(input: unknown): ShopDomain {
  const domain = normalizeShopDomain(input);
  if (!domain) throw new InvalidShopDomainError();
  return domain;
}
