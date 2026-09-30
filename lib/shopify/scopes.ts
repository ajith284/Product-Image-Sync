/**
 * Access scopes. Minimum set for adding images to EXISTING products:
 *   read_products  – find products by title
 *   write_products – attach media to products (productCreateMedia / productUpdate media)
 *   write_files    – create files from staged uploads
 *
 * Deliberately NOT requested: orders, customers, payments, themes, inventory, …
 * Adding a scope here forces every merchant to re-approve the app.
 */
export const REQUIRED_SHOPIFY_SCOPES = ["read_products", "write_products", "write_files"] as const;

/** Anything configured in SHOPIFY_SCOPES must be in this list. */
export const ALLOWED_SHOPIFY_SCOPES: readonly string[] = [...REQUIRED_SHOPIFY_SCOPES];

export function parseScopes(value: string): string[] {
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

/**
 * True when the scopes Shopify actually granted cover what the app needs.
 * Shopify: a write_X scope implicitly grants read_X.
 */
export function hasRequiredScopes(granted: string | string[], required: readonly string[] = REQUIRED_SHOPIFY_SCOPES) {
  const set = new Set(typeof granted === "string" ? parseScopes(granted) : granted);
  return required.every((scope) => set.has(scope) || (scope.startsWith("read_") && set.has(`write_${scope.slice(5)}`)));
}
