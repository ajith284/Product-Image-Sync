"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApiKeyError, createApiKey, revokeApiKey } from "@/lib/api-keys/service";
import { ALL_SCOPES, type ApiScope } from "@/lib/n8n/keys";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export type CreatedKey = { id: string; name: string; prefix: string; token: string; signingKey: string };
export type CreateKeyState = { error?: string; created?: CreatedKey } | undefined;

const MESSAGES: Record<ApiKeyError["code"], string> = {
  forbidden: "Only workspace owners and admins can manage API keys.",
  store_not_found: "That store isn't in this workspace.",
  too_many_keys: "This workspace already has the maximum of 25 active API keys. Revoke one first.",
  invalid_request: "Please check the form and try again.",
  not_found: "We couldn't find that API key.",
  unknown: "Something went wrong. Please try again.",
};

const schema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80, "Use at most 80 characters."),
  storeId: z.union([z.literal(""), z.uuid()]),
  scopes: z.array(z.enum(ALL_SCOPES as [ApiScope, ...ApiScope[]])).min(1, "Choose at least one permission."),
  expiresInDays: z.enum(["", "30", "90", "365"]),
});

/**
 * Creates a key in the CURRENT workspace (resolved server-side). The plaintext
 * token is returned once to this response only — it is never stored or logged.
 */
export async function createApiKeyAction(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageWorkspace")) return { error: MESSAGES.forbidden };
  const parsed = schema.safeParse({
    name: formData.get("name") ?? "",
    storeId: formData.get("storeId") ?? "",
    scopes: formData.getAll("scopes"),
    expiresInDays: formData.get("expiresInDays") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? MESSAGES.invalid_request };
  const { name, storeId, scopes, expiresInDays } = parsed.data;

  try {
    const created = await createApiKey({
      userId: ctx.user.id,
      workspaceId: ctx.workspace.workspaceId,
      storeId: storeId || null,
      name,
      scopes,
      expiresAt: expiresInDays ? new Date(Date.now() + Number(expiresInDays) * 86_400_000) : null,
    });
    revalidatePath("/settings/api-keys");
    return { created: { id: created.id, name, prefix: created.prefix, token: created.token, signingKey: created.signingKey } };
  } catch (error) {
    if (error instanceof ApiKeyError) return { error: MESSAGES[error.code] };
    console.error(`[api-keys] create: ${error instanceof Error ? error.name : "unknown"}`);
    return { error: MESSAGES.unknown };
  }
}

export async function revokeApiKeyAction(keyId: string): Promise<{ error?: string; ok?: boolean }> {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageWorkspace")) return { error: MESSAGES.forbidden };
  if (!z.uuid().safeParse(keyId).success) return { error: MESSAGES.not_found };
  try {
    await revokeApiKey(ctx.user.id, keyId);
    revalidatePath("/settings/api-keys");
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiKeyError) return { error: MESSAGES[error.code] };
    return { error: MESSAGES.unknown };
  }
}
