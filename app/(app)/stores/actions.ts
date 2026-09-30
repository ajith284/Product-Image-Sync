"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { friendlyDbError, MESSAGES } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { storeInfoSchema } from "@/lib/validation/store";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export type CreateStoreState =
  | { error?: string; fieldErrors?: Partial<Record<"name" | "shopifyDomain", string>> }
  | undefined;

/**
 * Creates a store record in "setup" status in the CURRENT workspace.
 * The workspace comes from the server-side context, never from the form.
 */
export async function createStore(_prev: CreateStoreState, formData: FormData): Promise<CreateStoreState> {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageStores")) return { error: MESSAGES.noPermission };

  const parsed = storeInfoSchema.safeParse({
    name: formData.get("name") ?? "",
    shopifyDomain: formData.get("shopifyDomain") ?? "",
  });
  if (!parsed.success) {
    const fieldErrors: NonNullable<CreateStoreState>["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as "name" | "shopifyDomain";
      fieldErrors[key] ??= issue.message;
    }
    return { fieldErrors };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("stores")
    .insert({
      workspace_id: ctx.workspace.workspaceId,
      name: parsed.data.name,
      shopify_domain: parsed.data.shopifyDomain,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      return { fieldErrors: { shopifyDomain: "This Shopify store is already added to this workspace." } };
    }
    return { error: friendlyDbError(error, "We couldn't add this store. Please try again.") };
  }

  revalidatePath("/stores");
  revalidatePath("/dashboard");
  redirect(`/stores/${data.id}?created=1`);
}
