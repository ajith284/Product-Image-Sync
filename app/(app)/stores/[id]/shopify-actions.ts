"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { startOAuth } from "@/lib/shopify/auth";
import { disconnectStore, verifyConnection } from "@/lib/shopify/connection";
import { getShopifyDeps, logShopifyError, toFlowError } from "@/lib/shopify/runtime";
import { authorizeStoreManager } from "@/lib/stores/authorize";

export type ShopifyActionState = { ok?: boolean; message?: string; error?: string } | undefined;

const authorizeStore = (storeId: string) =>
  authorizeStoreManager(storeId, "Only workspace owners and admins can manage the Shopify connection.");

export async function connectShopify(storeId: string): Promise<ShopifyActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };

  let url: string;
  try {
    url = await startOAuth(
      { userId: auth.ctx.user.id, storeId, storeShopDomain: auth.store.shopify_domain },
      getShopifyDeps(),
    );
  } catch (error) {
    logShopifyError("start", error);
    return { error: toFlowError(error, storeId).userMessage };
  }
  redirect(url); // to https://{shop}/admin/oauth/authorize
}

export async function verifyShopify(storeId: string): Promise<ShopifyActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  try {
    const result = await verifyConnection(storeId, getShopifyDeps(), { log: true });
    revalidatePath(`/stores/${storeId}`);
    return result.ok
      ? { ok: true, message: `Connected to ${result.shopName}. Everything looks good.` }
      : { error: result.message };
  } catch (error) {
    logShopifyError("verify", error);
    return { error: toFlowError(error, storeId).userMessage };
  }
}

export async function disconnectShopify(storeId: string): Promise<ShopifyActionState> {
  const auth = await authorizeStore(storeId);
  if ("error" in auth) return { error: auth.error };
  try {
    await disconnectStore(storeId, auth.ctx.user.id, getShopifyDeps());
    revalidatePath(`/stores/${storeId}`);
    revalidatePath("/stores");
    revalidatePath("/dashboard");
    return { ok: true, message: "Shopify disconnected. Your sync history was kept." };
  } catch (error) {
    logShopifyError("disconnect", error);
    return { error: toFlowError(error, storeId).userMessage };
  }
}
