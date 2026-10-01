import "server-only";

import { createHash, createHmac } from "node:crypto";

/**
 * Google token encryption = the shared AES-256-GCM helpers (lib/security/token-crypto.ts)
 * with Google's own key (GOOGLE_TOKEN_ENCRYPTION_KEY) and AAD context.
 */
export { decryptToken, encryptToken, TokenDecryptionError } from "@/lib/security/token-crypto";

export function googleTokenContext(storeId: string, kind: "access" | "refresh") {
  return `google_drive:${storeId}:${kind}`;
}

/**
 * PKCE (RFC 7636, S256) without storing anything extra: the code_verifier is
 * derived from the one-time state with a server-only key. Only a server that
 * holds the key AND the raw state (which exists only in the user's redirect)
 * can redeem the authorization code.
 */
export function pkceVerifier(state: string, key: Buffer): string {
  return createHmac("sha256", key).update(`google-pkce:${state}`, "utf8").digest("base64url"); // 43 chars
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
