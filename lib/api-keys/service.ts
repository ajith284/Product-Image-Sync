import "server-only";

import { ALL_SCOPES, generateApiKey, type ApiScope } from "@/lib/n8n/keys";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * API key management for the settings UI. The caller (server action / page)
 * has already checked session + owner/admin; the SQL functions re-check it.
 * Plaintext secrets exist only in the createApiKey() return value.
 */

export type ApiKeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  storeId: string | null;
  storeName: string | null;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export class ApiKeyError extends Error {
  constructor(readonly code: "forbidden" | "store_not_found" | "too_many_keys" | "invalid_request" | "not_found" | "unknown") {
    super(code);
    this.name = "ApiKeyError";
  }
}

function mapError(error: { message?: string } | null): never {
  const code = error?.message?.trim();
  const known = ["forbidden", "store_not_found", "too_many_keys", "invalid_request", "not_found"] as const;
  throw new ApiKeyError((known as readonly string[]).includes(code ?? "") ? (code as (typeof known)[number]) : "unknown");
}

export async function listApiKeys(userId: string, workspaceId: string): Promise<ApiKeyRow[]> {
  const { data, error } = await createAdminClient().rpc("api_keys_list", { p_user_id: userId, p_workspace_id: workspaceId });
  if (error) mapError(error);
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    keyPrefix: r.key_prefix,
    storeId: r.store_id,
    storeName: r.store_name,
    scopes: r.scopes as ApiScope[],
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

export async function createApiKey(input: {
  userId: string;
  workspaceId: string;
  storeId: string | null;
  name: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
}): Promise<{ id: string; token: string; signingKey: string; prefix: string }> {
  const scopes = input.scopes.filter((s) => ALL_SCOPES.includes(s));
  if (!scopes.length) throw new ApiKeyError("invalid_request");
  const key = generateApiKey();
  const { data, error } = await createAdminClient().rpc("api_key_create", {
    p_user_id: input.userId,
    p_workspace_id: input.workspaceId,
    p_store_id: input.storeId as string,
    p_name: input.name,
    p_scopes: scopes,
    p_key_prefix: key.prefix,
    p_secret_hash: key.secretHash,
    p_expires_at: (input.expiresAt?.toISOString() ?? null) as string,
  });
  if (error || !data) mapError(error);
  return { id: data as string, token: key.token, signingKey: key.signingKey, prefix: key.prefix };
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("api_key_revoke", { p_user_id: userId, p_key_id: keyId });
  if (error) mapError(error);
  return data === true;
}
