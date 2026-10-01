import "server-only";

/** Shopify token encryption: the shared AES-256-GCM helpers + Shopify's AAD context. */
export { decryptToken, encryptToken, TokenDecryptionError } from "@/lib/security/token-crypto";

export function tokenContext(storeId: string, shop: string, kind: "access" | "refresh") {
  return `shopify:${storeId}:${shop}:${kind}`;
}
