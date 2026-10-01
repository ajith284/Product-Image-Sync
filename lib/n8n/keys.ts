import "server-only";

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Product Image Sync API credentials (for n8n / background workers).
 *
 * Token:   pis_live_<12-char key id>_<43-char secret>
 *          e.g. pis_live_k3m9x2a7q1zt_Vb7Q…   (shown ONCE at creation)
 * Stored:  key_prefix = "pis_live_<12-char key id>"   (public, used for lookup)
 *          secret_hash = SHA-256(secret) as hex        (the secret is never stored)
 *
 * Optional request signing (HMAC-SHA256) uses a SIGNING KEY derived from the
 * secret: signingKey = SHA-256(secret) hex — i.e. the same value the server
 * stores. It is shown once together with the token. Standard primitives only.
 */

export const TOKEN_RE = /^(pis_live_[a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export type ApiScope = "n8n:read" | "n8n:sync" | "n8n:jobs";
export const API_SCOPES: { scope: ApiScope; label: string; description: string }[] = [
  { scope: "n8n:read", label: "Read status", description: "Read store connection status." },
  { scope: "n8n:sync", label: "Queue syncs", description: "Create (queue) sync jobs." },
  { scope: "n8n:jobs", label: "Manage jobs", description: "List, read and cancel sync jobs." },
];
export const ALL_SCOPES = API_SCOPES.map((s) => s.scope);

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateApiKey(): { token: string; prefix: string; secretHash: string; signingKey: string } {
  let id = "";
  for (let i = 0; i < 12; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  const prefix = `pis_live_${id}`;
  const secret = randomBytes(32).toString("base64url"); // 256 bits → 43 chars
  const secretHash = sha256Hex(secret);
  return { token: `${prefix}_${secret}`, prefix, secretHash, signingKey: secretHash };
}

export function parseApiToken(token: string): { prefix: string; secret: string } | null {
  const m = TOKEN_RE.exec(token.trim());
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Canonical string for request signing (v1), joined with "\n":
 *   v1
 *   <X-PIS-Timestamp, unix seconds>
 *   <HTTP method, uppercase>
 *   <path + query, e.g. /api/n8n/v1/sync-jobs?limit=20>
 *   <SHA-256 hex of the raw request body ("" for GET)>
 *   <X-Request-ID>
 */
export function canonicalString(p: { timestamp: string; method: string; pathWithQuery: string; body: string; requestId: string }) {
  return ["v1", p.timestamp, p.method.toUpperCase(), p.pathWithQuery, sha256Hex(p.body), p.requestId].join("\n");
}

/** X-PIS-Signature value: "v1=" + hex(HMAC-SHA256(signingKey, canonical)). */
export function signRequest(signingKey: string, canonical: string): string {
  return `v1=${createHmac("sha256", signingKey).update(canonical, "utf8").digest("hex")}`;
}

export function verifySignature(signingKey: string, canonical: string, header: string): boolean {
  const m = /^v1=([a-f0-9]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", signingKey).update(canonical, "utf8").digest();
  const actual = Buffer.from(m[1]!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
