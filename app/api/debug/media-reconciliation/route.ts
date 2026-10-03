import { NextResponse } from "next/server";
import { z } from "zod";

import { getAttachedProductMediaIds, ShopifyUploadError } from "@/lib/shopify/media";
import { getShopifyDeps } from "@/lib/shopify/runtime";
import { createClient } from "@/lib/supabase/server";
import { loadWorkspaceContext, SessionExpiredError } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const TARGETS = ["Satet", "Tale", "TUSCANY", "WELLINGTON"] as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storeId = url.searchParams.get("storeId");
  if (!storeId || !z.uuid().safeParse(storeId).success) {
    return json({ error: "A valid storeId is required." }, 400);
  }

  let ctx;
  try {
    ctx = await loadWorkspaceContext();
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return json({ error: "Your session expired." }, 401);
    }
    return json({ error: "We couldn't load your workspace." }, 500);
  }
  if (!ctx?.workspace) return json({ error: "Please sign in again." }, 401);

  const supabase = await createClient();

  const { data: store, error: storeError } = await supabase
    .from("stores")
    .select("id, name")
    .eq("id", storeId)
    .eq("workspace_id", ctx.workspace.workspaceId)
    .maybeSingle();

  if (storeError) return json({ error: "We couldn't read the store." }, 500);
  if (!store) return json({ error: "Store not found." }, 404);

  const { data: items, error: itemsError } = await supabase
    .from("sync_items")
    .select(
      "id, sync_job_id, drive_folder_name, shopify_product_id, shopify_product_title, status, images_found, images_uploaded, images_skipped, images_failed, updated_at",
    )
    .eq("store_id", storeId)
    .in("drive_folder_name", [...TARGETS])
    .order("updated_at", { ascending: false });

  if (itemsError) {
    return json({ error: "We couldn't read sync items." }, 500);
  }

  const latestByFolder = new Map<string, NonNullable<typeof items>[number]>();
  for (const item of items ?? []) {
    const key = item.drive_folder_name.trim().toLowerCase();
    if (!latestByFolder.has(key)) latestByFolder.set(key, item);
  }

  const productIds = [
    ...new Set(
      [...latestByFolder.values()]
        .map((item) => item.shopify_product_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const { data: ledgerRows, error: ledgerError } = productIds.length
    ? await supabase
        .from("sync_images")
        .select(
          "shopify_product_id, drive_file_id, filename, upload_status, shopify_media_id, checksum, drive_modified_at, uploaded_at",
        )
        .eq("store_id", storeId)
        .in("shopify_product_id", productIds)
        .order("filename", { ascending: true })
    : { data: [], error: null };

  if (ledgerError) {
    return json({ error: "We couldn't read the image ledger." }, 500);
  }

  const shopify = getShopifyDeps();
  const products = [];

  for (const folder of TARGETS) {
    const item = latestByFolder.get(folder.toLowerCase()) ?? null;
    if (!item?.shopify_product_id) {
      products.push({
        folder,
        sync_item_found: Boolean(item),
        product_id: item?.shopify_product_id ?? null,
        product_title: item?.shopify_product_title ?? null,
        shopify_error: null,
        counts: { ledger: 0, attached: 0, missing: 0 },
        files: [],
      });
      continue;
    }

    let attached = new Set<string>();
    let shopifyError: { code: string; message: string } | null = null;
    try {
      attached = await getAttachedProductMediaIds(
        {
          workspaceId: ctx.workspace.workspaceId,
          storeId,
          productId: item.shopify_product_id,
        },
        shopify,
      );
    } catch (error) {
      if (error instanceof ShopifyUploadError) {
        shopifyError = { code: error.code, message: error.publicMessage };
      } else {
        shopifyError = {
          code: "INTERNAL_ERROR",
          message: "Shopify media could not be checked.",
        };
      }
    }

    const rows = (ledgerRows ?? []).filter(
      (row) => row.shopify_product_id === item.shopify_product_id,
    );

    const files = rows.map((row) => {
      const attachedNow =
        Boolean(row.shopify_media_id) && attached.has(row.shopify_media_id!);
      return {
        filename: row.filename,
        drive_file_id: row.drive_file_id,
        upload_status: row.upload_status,
        shopify_media_id: row.shopify_media_id,
        attached_now: attachedNow,
        missing_now:
          row.upload_status === "uploaded" && !attachedNow,
      };
    });

    products.push({
      folder,
      sync_item_found: true,
      sync_job_id: item.sync_job_id,
      sync_status: item.status,
      product_id: item.shopify_product_id,
      product_title: item.shopify_product_title,
      last_sync_counts: {
        found: item.images_found,
        uploaded: item.images_uploaded,
        skipped: item.images_skipped,
        failed: item.images_failed,
      },
      shopify_error: shopifyError,
      counts: {
        ledger: files.length,
        attached: attached.size,
        missing: files.filter((file) => file.missing_now).length,
      },
      files,
    });
  }

  return json({
    ok: true,
    read_only_diagnostic: true,
    store: { id: store.id, name: store.name },
    targets: TARGETS,
    products,
  });
}
