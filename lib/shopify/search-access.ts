import "server-only";

import { z } from "zod";

import { SHOPIFY_FLOW_MESSAGES } from "@/lib/shopify/errors";
import { createClient } from "@/lib/supabase/server";
import { loadWorkspaceContext, SessionExpiredError } from "@/lib/workspace";

export type ProductSearchAccess =
  | { ok: true; userId: string; workspaceId: string; storeId: string }
  | { ok: false; status: 401 | 403 | 404 | 409; error: string };

export const ACCESS_MESSAGES = {
  signedOut: "Please sign in again.",
  noWorkspace: "You don't belong to a workspace yet.",
  storeNotFound: "We couldn't find this store in your workspace.",
} as const;

/**
 * Authorization for product search, in order:
 * 1. signed-in user (verified JWT via getClaims)
 * 2. workspace membership (the CURRENT workspace, resolved server-side)
 * 3. store belongs to that workspace (RLS-scoped query + explicit workspace filter)
 * 4. the store has a connected Shopify connection
 * Any workspace role may search (read-only; members need it for manual mappings).
 * The store id from the request is never trusted on its own.
 */
export async function authorizeProductSearch(storeId: string): Promise<ProductSearchAccess> {
  let ctx: Awaited<ReturnType<typeof loadWorkspaceContext>>;
  try {
    ctx = await loadWorkspaceContext();
  } catch (error) {
    if (error instanceof SessionExpiredError) return { ok: false, status: 401, error: ACCESS_MESSAGES.signedOut };
    throw error;
  }
  if (!ctx) return { ok: false, status: 401, error: ACCESS_MESSAGES.signedOut };
  if (!ctx.workspace) return { ok: false, status: 403, error: ACCESS_MESSAGES.noWorkspace };

  // Same response for "invalid id", "other workspace" and "doesn't exist": no enumeration.
  if (!z.uuid().safeParse(storeId).success) return { ok: false, status: 404, error: ACCESS_MESSAGES.storeNotFound };

  const workspaceId = ctx.workspace.workspaceId;
  const supabase = await createClient();
  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (storeError) throw new Error("Could not load store");
  if (!store) return { ok: false, status: 404, error: ACCESS_MESSAGES.storeNotFound };

  const { data: connection, error: connError } = await supabase
    .from("shopify_connections")
    .select("connection_status")
    .eq("store_id", storeId)
    .maybeSingle();
  if (connError) throw new Error("Could not load Shopify connection");
  if (!connection || connection.connection_status === "disconnected" || connection.connection_status === "pending") {
    return { ok: false, status: 409, error: SHOPIFY_FLOW_MESSAGES.not_connected };
  }
  if (connection.connection_status === "needs_reconnect") {
    return { ok: false, status: 409, error: SHOPIFY_FLOW_MESSAGES.needs_reconnect };
  }
  if (connection.connection_status !== "connected") {
    return { ok: false, status: 409, error: SHOPIFY_FLOW_MESSAGES.verify_failed };
  }

  return { ok: true, userId: ctx.user.id, workspaceId, storeId };
}
