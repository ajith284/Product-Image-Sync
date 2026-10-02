import "server-only";

import { ShopifyFlowError, isShopifyFlowErrorCode, type ShopifyFlowErrorCode } from "@/lib/shopify/errors";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Data access for the Shopify connection flow. Every call goes through a
 * service-role-only SECURITY DEFINER function (supabase/migrations/*_shopify_oauth.sql).
 * Only encrypted token values ever cross this boundary.
 */

export type ConsumedState =
  | { status: "ok"; userId: string; workspaceId: string; storeId: string; shopDomain: string }
  | { status: "unknown" | "reused" | "expired" };

export type StoredCredentials = {
  connectionId: string;
  workspaceId: string;
  shopDomain: string;
  connectionStatus: string;
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  tokenVersion: number;
};

export type SaveConnectionInput = {
  storeId: string;
  workspaceId: string;
  userId: string;
  shopDomain: string;
  scopes: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
};

export interface ShopifyRepository {
  beginOAuth(input: { userId: string; storeId: string; stateHash: string; ttlSeconds: number }): Promise<string>;
  consumeState(stateHash: string): Promise<ConsumedState>;
  saveConnection(input: SaveConnectionInput): Promise<string>;
  getCredentials(storeId: string): Promise<StoredCredentials | null>;
  storeRefreshedTokens(input: {
    connectionId: string;
    expectedVersion: number;
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
  }): Promise<boolean>;
  recordVerification(input: {
    storeId: string;
    ok: boolean;
    failureStatus?: "needs_reconnect" | "error";
    shopifyShopId?: string | null;
    error?: string | null;
    log?: boolean;
  }): Promise<void>;
  disconnect(storeId: string, userId: string): Promise<boolean>;
  handleAppUninstalled(webhookId: string, shopDomain: string): Promise<string>;
  /** Mandatory shop/redact: erase this shop's Shopify data (Prompt 14F). Idempotent per webhook id. */
  handleShopRedact(webhookId: string, shopDomain: string): Promise<string>;
  recordWebhook(webhookId: string, topic: string, shopDomain: string | null): Promise<boolean>;
}

/** Map a raised SQL exception ("forbidden", "shop_connected_elsewhere", …) to a flow error. */
function mapError(error: { message?: string } | null, fallback: ShopifyFlowErrorCode): never {
  const code = error?.message?.trim();
  throw new ShopifyFlowError(isShopifyFlowErrorCode(code) ? code : fallback);
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (s: string | null) => (s ? new Date(s) : null);

export function createShopifyRepository(): ShopifyRepository {
  const db = createAdminClient();

  return {
    async beginOAuth({ userId, storeId, stateHash, ttlSeconds }) {
      const { data, error } = await db.rpc("shopify_begin_oauth", {
        p_user_id: userId,
        p_store_id: storeId,
        p_state_hash: stateHash,
        p_ttl_seconds: ttlSeconds,
      });
      if (error || !data) mapError(error, "unknown");
      return data as string;
    },

    async consumeState(stateHash) {
      const { data, error } = await db.rpc("shopify_consume_oauth_state", { p_state_hash: stateHash });
      if (error) mapError(error, "unknown");
      const row = data?.[0];
      if (!row) return { status: "unknown" };
      if (row.status === "ok" && row.user_id && row.workspace_id && row.store_id && row.shop_domain) {
        return {
          status: "ok",
          userId: row.user_id,
          workspaceId: row.workspace_id,
          storeId: row.store_id,
          shopDomain: row.shop_domain,
        };
      }
      return { status: row.status === "reused" || row.status === "expired" ? row.status : "unknown" };
    },

    async saveConnection(input) {
      const { data, error } = await db.rpc("shopify_save_connection", {
        p_store_id: input.storeId,
        p_workspace_id: input.workspaceId,
        p_user_id: input.userId,
        p_shop_domain: input.shopDomain,
        p_scopes: input.scopes,
        p_encrypted_access_token: input.encryptedAccessToken,
        p_encrypted_refresh_token: input.encryptedRefreshToken,
        p_access_expires_at: iso(input.accessExpiresAt),
        p_refresh_expires_at: iso(input.refreshExpiresAt),
      });
      if (error || !data) mapError(error, "unknown");
      return data as string;
    },

    async getCredentials(storeId) {
      const { data, error } = await db.rpc("shopify_get_credentials", { p_store_id: storeId });
      if (error) mapError(error, "unknown");
      const row = data?.[0];
      if (!row) return null;
      return {
        connectionId: row.connection_id,
        workspaceId: row.workspace_id,
        shopDomain: row.shop_domain,
        connectionStatus: row.connection_status,
        encryptedAccessToken: row.encrypted_access_token,
        encryptedRefreshToken: row.encrypted_refresh_token,
        tokenExpiresAt: date(row.token_expires_at),
        refreshTokenExpiresAt: date(row.refresh_token_expires_at),
        tokenVersion: row.token_version,
      };
    },

    async storeRefreshedTokens(input) {
      const { data, error } = await db.rpc("shopify_store_refreshed_tokens", {
        p_connection_id: input.connectionId,
        p_expected_version: input.expectedVersion,
        p_encrypted_access_token: input.encryptedAccessToken,
        p_encrypted_refresh_token: input.encryptedRefreshToken,
        p_access_expires_at: iso(input.accessExpiresAt),
        p_refresh_expires_at: iso(input.refreshExpiresAt),
      });
      if (error) mapError(error, "unknown");
      return data === true;
    },

    async recordVerification({ storeId, ok, failureStatus, shopifyShopId, error: message, log }) {
      const { error } = await db.rpc("shopify_record_verification", {
        p_store_id: storeId,
        p_ok: ok,
        p_failure_status: failureStatus ?? null,
        p_shopify_shop_id: shopifyShopId ?? null,
        p_error: message ?? null,
        p_log: log ?? false,
      });
      if (error) mapError(error, "unknown");
    },

    async disconnect(storeId, userId) {
      const { data, error } = await db.rpc("shopify_disconnect", { p_store_id: storeId, p_user_id: userId });
      if (error) mapError(error, "unknown");
      return data === true;
    },

    async handleAppUninstalled(webhookId, shopDomain) {
      const { data, error } = await db.rpc("shopify_handle_app_uninstalled", {
        p_webhook_id: webhookId,
        p_shop_domain: shopDomain,
      });
      if (error) mapError(error, "unknown");
      return data ?? "unknown";
    },

    async handleShopRedact(webhookId, shopDomain) {
      const { data, error } = await db.rpc("shopify_handle_shop_redact", {
        p_webhook_id: webhookId,
        p_shop_domain: shopDomain,
      });
      if (error) mapError(error, "unknown");
      return data ?? "unknown";
    },

    async recordWebhook(webhookId, topic, shopDomain) {
      const { data, error } = await db.rpc("shopify_record_webhook", {
        p_webhook_id: webhookId,
        p_topic: topic,
        p_shop_domain: shopDomain,
      });
      if (error) mapError(error, "unknown");
      return data === true;
    },
  };
}
