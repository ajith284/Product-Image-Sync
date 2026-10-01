import "server-only";

import { GoogleFlowError, isGoogleFlowErrorCode, type GoogleFlowErrorCode } from "@/lib/google/errors";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Data access for the Google Drive connection. Every call goes through a
 * service-role-only SECURITY DEFINER function
 * (supabase/migrations/*_google_drive_oauth.sql). Only encrypted token values
 * ever cross this boundary.
 */

export type ConsumedGoogleState =
  | { status: "ok"; userId: string; workspaceId: string; storeId: string }
  | { status: "unknown" | "reused" | "expired" };

export type StoredGoogleCredentials = {
  connectionId: string;
  workspaceId: string;
  googleAccountId: string;
  connectionStatus: string;
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
  tokenVersion: number;
  /** Another active store connection uses the same Google account. */
  accountShared: boolean;
};

export type SaveGoogleConnectionInput = {
  storeId: string;
  workspaceId: string;
  userId: string;
  googleAccountId: string;
  googleAccountEmail: string | null;
  scopes: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessExpiresAt: Date | null;
};

export interface GoogleRepository {
  beginOAuth(input: { userId: string; storeId: string; stateHash: string; ttlSeconds: number }): Promise<string>;
  consumeState(stateHash: string): Promise<ConsumedGoogleState>;
  saveConnection(input: SaveGoogleConnectionInput): Promise<string>;
  getCredentials(storeId: string): Promise<StoredGoogleCredentials | null>;
  storeRefreshedTokens(input: {
    connectionId: string;
    expectedVersion: number;
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    accessExpiresAt: Date | null;
  }): Promise<boolean>;
  recordVerification(input: {
    storeId: string;
    ok: boolean;
    failureStatus?: "needs_reconnect" | "error";
    accountEmail?: string | null;
    error?: string | null;
    log?: boolean;
  }): Promise<void>;
  disconnect(storeId: string, userId: string): Promise<boolean>;
}

function mapError(error: { message?: string } | null, fallback: GoogleFlowErrorCode): never {
  const code = error?.message?.trim();
  throw new GoogleFlowError(isGoogleFlowErrorCode(code) ? code : fallback);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s ? new Date(s) : null);

export function createGoogleRepository(): GoogleRepository {
  const db = createAdminClient();

  return {
    async beginOAuth({ userId, storeId, stateHash, ttlSeconds }) {
      const { data, error } = await db.rpc("google_begin_oauth", {
        p_user_id: userId,
        p_store_id: storeId,
        p_state_hash: stateHash,
        p_ttl_seconds: ttlSeconds,
      });
      if (error || !data) mapError(error, "unknown");
      return data as string;
    },

    async consumeState(stateHash) {
      const { data, error } = await db.rpc("google_consume_oauth_state", { p_state_hash: stateHash });
      if (error) mapError(error, "unknown");
      const row = data?.[0];
      if (!row) return { status: "unknown" };
      if (row.status === "ok" && row.user_id && row.workspace_id && row.store_id) {
        return { status: "ok", userId: row.user_id, workspaceId: row.workspace_id, storeId: row.store_id };
      }
      return { status: row.status === "reused" || row.status === "expired" ? row.status : "unknown" };
    },

    async saveConnection(input) {
      const { data, error } = await db.rpc("google_save_connection", {
        p_store_id: input.storeId,
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_google_account_id: input.googleAccountId,
        // Generated types mark nullable SQL args as string; null is valid at runtime.
        p_google_account_email: input.googleAccountEmail as string,
        p_scopes: input.scopes,
        p_encrypted_access_token: input.encryptedAccessToken,
        p_encrypted_refresh_token: input.encryptedRefreshToken as string,
        p_access_expires_at: iso(input.accessExpiresAt) as string,
      });
      if (error || !data) mapError(error, "unknown");
      return data as string;
    },

    async getCredentials(storeId) {
      const { data, error } = await db.rpc("google_get_credentials", { p_store_id: storeId });
      if (error) mapError(error, "unknown");
      const row = data?.[0];
      if (!row) return null;
      return {
        connectionId: row.connection_id,
        workspaceId: row.workspace_id,
        googleAccountId: row.google_account_id,
        connectionStatus: row.connection_status,
        encryptedAccessToken: row.encrypted_access_token,
        encryptedRefreshToken: row.encrypted_refresh_token,
        tokenExpiresAt: date(row.token_expires_at),
        tokenVersion: row.token_version,
        accountShared: row.account_shared === true,
      };
    },

    async storeRefreshedTokens(input) {
      const { data, error } = await db.rpc("google_store_refreshed_tokens", {
        p_connection_id: input.connectionId,
        p_expected_version: input.expectedVersion,
        p_encrypted_access_token: input.encryptedAccessToken,
        p_encrypted_refresh_token: input.encryptedRefreshToken as string,
        p_access_expires_at: iso(input.accessExpiresAt) as string,
      });
      if (error) mapError(error, "unknown");
      return data === true;
    },

    async recordVerification({ storeId, ok, failureStatus, accountEmail, error: message, log }) {
      const { error } = await db.rpc("google_record_verification", {
        p_store_id: storeId,
        p_ok: ok,
        p_failure_status: failureStatus ?? undefined,
        p_account_email: accountEmail ?? undefined,
        p_error: message ?? undefined,
        p_log: log ?? false,
      });
      if (error) mapError(error, "unknown");
    },

    async disconnect(storeId, userId) {
      const { data, error } = await db.rpc("google_disconnect", { p_store_id: storeId, p_user_id: userId });
      if (error) mapError(error, "unknown");
      return data === true;
    },
  };
}
