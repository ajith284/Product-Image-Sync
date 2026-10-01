import "server-only";

import { z } from "zod";

import { MESSAGES } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

/**
 * Shared check for store integration actions (Shopify, Google Drive):
 * session → workspace membership → owner/admin → store belongs to the CURRENT
 * workspace (RLS-scoped query). The store id from the form is never trusted on
 * its own. The database functions re-check permission again.
 */
export async function authorizeStoreManager(storeId: string, forbiddenMessage: string) {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageStores")) return { error: forbiddenMessage } as const;
  if (!z.uuid().safeParse(storeId).success) return { error: MESSAGES.noAccess } as const;

  const supabase = await createClient();
  const { data: store } = await supabase
    .from("stores")
    .select("id, shopify_domain")
    .eq("id", storeId)
    .eq("workspace_id", ctx.workspace.workspaceId)
    .maybeSingle();
  if (!store) return { error: "We couldn't find this store in your workspace." } as const;
  return { ctx, store } as const;
}
