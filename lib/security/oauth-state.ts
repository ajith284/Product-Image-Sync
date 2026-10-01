import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * One-time OAuth state shared by every provider (Shopify, Google Drive).
 * 32 random bytes, URL-safe. Only the SHA-256 hash is stored
 * (internal.oauth_states), bound to user + workspace + store, 10-minute expiry,
 * consumed once by the provider's *_consume_oauth_state database function.
 */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export function createOAuthState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, stateHash: hashOAuthState(state) };
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}
