import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type ManualProductMapping = {
  storeId: string;
  driveFolderId: string;
  driveFolderName: string | null;
  shopifyProductId: string;
  shopifyProductTitle: string | null;
};

/**
 * Worker-side lookup for a manual Drive-folder -> Shopify-product mapping.
 * The admin client bypasses RLS, so workspace -> store ownership is checked
 * explicitly before the mapping row is read.
 */
export async function getManualProductMapping(input: {
  workspaceId: string;
  storeId: string;
  driveFolderId: string;
}): Promise<ManualProductMapping | null> {
  const db = createAdminClient();

  const { data: store, error: storeError } = await db
    .from("stores")
    .select("id")
    .eq("id", input.storeId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (storeError) throw new Error("Could not verify product mapping store");
  if (!store) return null;

  const { data, error } = await db
    .from("product_mappings")
    .select("store_id, drive_folder_id, drive_folder_name, shopify_product_id, shopify_product_title")
    .eq("store_id", input.storeId)
    .eq("drive_folder_id", input.driveFolderId)
    .eq("mapping_type", "manual")
    .maybeSingle();

  if (error) throw new Error("Could not load product mapping");
  if (!data) return null;

  return {
    storeId: data.store_id,
    driveFolderId: data.drive_folder_id,
    driveFolderName: data.drive_folder_name,
    shopifyProductId: data.shopify_product_id,
    shopifyProductTitle: data.shopify_product_title,
  };
}
