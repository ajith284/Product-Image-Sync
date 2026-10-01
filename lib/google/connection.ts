import "server-only";

import { createDriveClient, DriveApiError, type DriveClient } from "@/lib/google/client";
import type { GoogleConfig } from "@/lib/google/config";
import { decryptToken, encryptToken, googleTokenContext, TokenDecryptionError } from "@/lib/google/crypto";
import { GoogleFlowError } from "@/lib/google/errors";
import type { GoogleRepository, StoredGoogleCredentials } from "@/lib/google/repository";
import { refreshGoogleAccessToken, revokeGoogleToken } from "@/lib/google/tokens";

/**
 * Server-only Google Drive connection service: save, refresh, verify,
 * disconnect. Tokens are decrypted just-in-time and never leave this module
 * except in requests to Google.
 */

export type GoogleDeps = {
  config: GoogleConfig;
  repo: GoogleRepository;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Refresh when the access token has less than this left (Google: ~1 hour tokens). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const nowOf = (deps: GoogleDeps) => (deps.now ? deps.now() : Date.now());

async function markNeedsReconnect(deps: GoogleDeps, storeId: string) {
  await deps.repo.recordVerification({
    storeId,
    ok: false,
    failureStatus: "needs_reconnect",
    error: "Google Drive needs to be reconnected.",
  });
}

function decrypt(value: string | null, deps: GoogleDeps, storeId: string, kind: "access" | "refresh") {
  if (!value) return null;
  return decryptToken(value, deps.config.tokenEncryptionKey, googleTokenContext(storeId, kind));
}

/** Encrypt the tokens and save connection + secrets atomically (the DB re-checks permission). */
export async function saveGoogleConnection(
  input: {
    storeId: string;
    workspaceId: string;
    userId: string;
    googleAccountId: string;
    googleAccountEmail: string | null;
    scopes: string;
    accessToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
  },
  deps: GoogleDeps,
): Promise<string> {
  const key = deps.config.tokenEncryptionKey;
  try {
    return await deps.repo.saveConnection({
      storeId: input.storeId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      googleAccountId: input.googleAccountId,
      googleAccountEmail: input.googleAccountEmail,
      scopes: input.scopes,
      encryptedAccessToken: encryptToken(input.accessToken, key, googleTokenContext(input.storeId, "access")),
      encryptedRefreshToken: input.refreshToken
        ? encryptToken(input.refreshToken, key, googleTokenContext(input.storeId, "refresh"))
        : null,
      accessExpiresAt: input.accessExpiresAt,
    });
  } catch (error) {
    throw error instanceof GoogleFlowError ? new GoogleFlowError(error.code, { storeId: input.storeId }) : error;
  }
}

/**
 * Returns a usable access token for the store, refreshing it first when it is
 * about to expire (or when `force` is set after a 401). Concurrent refreshes
 * are resolved with optimistic locking (token_version).
 */
export async function refreshGoogleToken(
  storeId: string,
  deps: GoogleDeps,
  opts: { force?: boolean } = {},
): Promise<{ accessToken: string; credentials: StoredGoogleCredentials }> {
  const creds = await deps.repo.getCredentials(storeId);
  if (!creds || !creds.encryptedAccessToken) throw new GoogleFlowError("not_connected", { storeId });

  let accessToken: string | null;
  try {
    accessToken = decrypt(creds.encryptedAccessToken, deps, storeId, "access");
  } catch (error) {
    if (error instanceof TokenDecryptionError) {
      await markNeedsReconnect(deps, storeId);
      throw new GoogleFlowError("needs_reconnect", { storeId });
    }
    throw error;
  }

  const t = nowOf(deps);
  const fresh = !opts.force && creds.tokenExpiresAt !== null && creds.tokenExpiresAt.getTime() - t > REFRESH_MARGIN_MS;
  if (fresh && accessToken) return { accessToken, credentials: creds };

  let refreshToken: string | null = null;
  try {
    refreshToken = decrypt(creds.encryptedRefreshToken, deps, storeId, "refresh");
  } catch {
    refreshToken = null;
  }
  if (!refreshToken) {
    await markNeedsReconnect(deps, storeId);
    throw new GoogleFlowError("needs_reconnect", { storeId });
  }

  const result = await refreshGoogleAccessToken(refreshToken, deps.config, deps.fetch ?? fetch, t);
  if (!result.ok) {
    if (result.reason === "rejected") {
      await markNeedsReconnect(deps, storeId);
      throw new GoogleFlowError("needs_reconnect", { storeId });
    }
    throw new GoogleFlowError("verify_failed", { storeId });
  }

  const key = deps.config.tokenEncryptionKey;
  const saved = await deps.repo.storeRefreshedTokens({
    connectionId: creds.connectionId,
    expectedVersion: creds.tokenVersion,
    encryptedAccessToken: encryptToken(result.tokens.accessToken, key, googleTokenContext(storeId, "access")),
    // Google normally keeps the same refresh token; store a new one only if sent.
    encryptedRefreshToken: result.tokens.refreshToken
      ? encryptToken(result.tokens.refreshToken, key, googleTokenContext(storeId, "refresh"))
      : null,
    accessExpiresAt: result.tokens.accessExpiresAt,
  });
  if (saved) return { accessToken: result.tokens.accessToken, credentials: creds };

  // Another process refreshed first — use what it stored.
  const latest = await deps.repo.getCredentials(storeId);
  const latestAccess = latest ? decrypt(latest.encryptedAccessToken, deps, storeId, "access") : null;
  if (!latest || !latestAccess) throw new GoogleFlowError("verify_failed", { storeId });
  return { accessToken: latestAccess, credentials: latest };
}

/**
 * A Drive client for the store using its stored credentials. Retries once with
 * a forced token refresh when Google answers 401.
 */
export async function getDriveClient(storeId: string, deps: GoogleDeps): Promise<DriveClient> {
  let { accessToken } = await refreshGoogleToken(storeId, deps);
  const make = (token: string) => createDriveClient({ accessToken: token, fetch: deps.fetch });
  let client = make(accessToken);
  return {
    async get<T>(path: string, query?: Record<string, string>) {
      try {
        return await client.get<T>(path, query);
      } catch (error) {
        if (!(error instanceof DriveApiError) || error.kind !== "unauthorized") throw error;
        ({ accessToken } = await refreshGoogleToken(storeId, deps, { force: true }));
        client = make(accessToken);
        return client.get<T>(path, query);
      }
    },
    async getAbout() {
      try {
        return await client.getAbout();
      } catch (error) {
        if (!(error instanceof DriveApiError) || error.kind !== "unauthorized") throw error;
        ({ accessToken } = await refreshGoogleToken(storeId, deps, { force: true }));
        client = make(accessToken);
        return client.getAbout();
      }
    },
  };
}

export type GoogleVerifyResult =
  | { ok: true; email: string | null }
  | { ok: false; code: "needs_reconnect" | "verify_failed" | "not_connected" | "drive_api_disabled"; message: string };

/**
 * READ-ONLY check: asks Drive who is connected (about.get). Never reads files.
 * Records the result (connected / needs_reconnect / error) on the connection.
 */
export async function verifyGoogleConnection(
  storeId: string,
  deps: GoogleDeps,
  opts: { log?: boolean } = {},
): Promise<GoogleVerifyResult> {
  let drive: DriveClient;
  try {
    drive = await getDriveClient(storeId, deps);
  } catch (error) {
    if (error instanceof GoogleFlowError && (error.code === "needs_reconnect" || error.code === "not_connected")) {
      return { ok: false, code: error.code, message: error.userMessage };
    }
    return { ok: false, code: "verify_failed", message: new GoogleFlowError("verify_failed").userMessage };
  }

  try {
    const about = await drive.getAbout();
    await deps.repo.recordVerification({ storeId, ok: true, accountEmail: about.emailAddress, log: opts.log });
    return { ok: true, email: about.emailAddress };
  } catch (error) {
    if (error instanceof GoogleFlowError && error.code === "needs_reconnect") {
      return { ok: false, code: "needs_reconnect", message: error.userMessage };
    }
    if (error instanceof DriveApiError) {
      if (error.kind === "unauthorized" || error.kind === "insufficient_scope") {
        await deps.repo.recordVerification({ storeId, ok: false, failureStatus: "needs_reconnect", error: error.userMessage, log: opts.log });
        return { ok: false, code: "needs_reconnect", message: error.userMessage };
      }
      if (error.kind === "api_disabled") {
        await deps.repo.recordVerification({ storeId, ok: false, failureStatus: "error", error: error.userMessage, log: opts.log });
        return { ok: false, code: "drive_api_disabled", message: error.userMessage };
      }
      if (!error.retryable) {
        await deps.repo.recordVerification({ storeId, ok: false, failureStatus: "error", error: error.userMessage, log: opts.log });
      }
      return { ok: false, code: "verify_failed", message: error.userMessage };
    }
    throw error;
  }
}

/**
 * Disconnect: revoke Google's grant (best effort) ONLY when no other store
 * still uses the same Google account — Google revokes the whole account↔app
 * grant, which would silently break the other store. Then ALWAYS delete the
 * stored credentials and mark the connection disconnected (history kept).
 * Caller must have authorized the user; the SQL function re-checks owner/admin.
 */
export async function disconnectGoogle(
  storeId: string,
  userId: string,
  deps: GoogleDeps,
): Promise<{ revoked: boolean }> {
  let revoked = false;
  try {
    const creds = await deps.repo.getCredentials(storeId);
    if (creds && !creds.accountShared) {
      const token =
        decrypt(creds.encryptedRefreshToken, deps, storeId, "refresh") ??
        decrypt(creds.encryptedAccessToken, deps, storeId, "access");
      if (token) revoked = await revokeGoogleToken(token, deps.fetch ?? fetch);
    }
  } catch {
    // Ignore: local credentials are removed regardless.
  }
  await deps.repo.disconnect(storeId, userId);
  return { revoked };
}
