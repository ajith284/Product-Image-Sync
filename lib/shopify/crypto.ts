import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Token encryption at rest: AES-256-GCM (authenticated encryption) from Node's
 * built-in crypto — no custom cryptography.
 *
 * Format:  v1.<iv>.<ciphertext>.<authTag>   (base64url parts, 12-byte IV, 16-byte tag)
 *
 * `context` is bound as Additional Authenticated Data, e.g.
 * "shopify:<storeId>:<shop>:access", so a ciphertext copied to another row or
 * swapped between access/refresh fails to decrypt.
 *
 * The key (SHOPIFY_TOKEN_ENCRYPTION_KEY, 32 bytes) lives only in server env,
 * never in the database. Never log plaintext or ciphertext.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class TokenDecryptionError extends Error {
  constructor() {
    super("Stored credentials could not be decrypted");
    this.name = "TokenDecryptionError";
  }
}

function assertKey(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Encryption key must be 32 bytes");
}

export function encryptToken(plaintext: string, key: Buffer, context: string): string {
  assertKey(key);
  if (!plaintext) throw new Error("Nothing to encrypt");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptToken(payload: string, key: Buffer, context: string): string {
  assertKey(key);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenDecryptionError();
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const ciphertext = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new TokenDecryptionError();
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenDecryptionError();
  }
}

export function tokenContext(storeId: string, shop: string, kind: "access" | "refresh") {
  return `shopify:${storeId}:${shop}:${kind}`;
}
