"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { requireWorkspace } from "@/lib/workspace";

const mappingSchema = z.object({
  storeId: z.string().uuid(),
  driveFolderId: z.string().min(1).max(200),
  driveFolderName: z.string().max(500).nullable(),
  shopifyProductId: z.string().regex(/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/),
  shopifyProductTitle: z.string().min(1).max(500),
});

export type SaveProductMappingInput = z.infer<typeof mappingSchema>;

export async function saveProductMapping(
  input: SaveProductMappingInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = mappingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid product mapping." };

  const ctx = await requireWorkspace();
  const supabase = await createClient();

  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("id")
    .eq("id", parsed.data.storeId)
    .eq("workspace_id", ctx.workspace.workspaceId)
    .maybeSingle();

  if (storeError || !store) {
    return { ok: false, error: "We couldn't find this store in your workspace." };
  }

  const { error } = await supabase
    .from("product_mappings")
    .upsert(
      {
        store_id: parsed.data.storeId,
        drive_folder_id: parsed.data.driveFolderId,
        drive_folder_name: parsed.data.driveFolderName,
        shopify_product_id: parsed.data.shopifyProductId,
        shopify_product_title: parsed.data.shopifyProductTitle,
        mapping_type: "manual",
        created_by: ctx.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id,drive_folder_id" },
    );

  if (error) return { ok: false, error: "We couldn't save this product mapping." };

  revalidatePath("/review");
  revalidatePath("/sync-jobs");
  revalidatePath(`/stores/${parsed.data.storeId}`);
  return { ok: true };
}
