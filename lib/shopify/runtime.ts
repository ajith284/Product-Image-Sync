import "server-only";

import { ShopifyApiError } from "@/lib/shopify/client";
import { getShopifyConfig, ShopifyConfigError } from "@/lib/shopify/config";
import type { ConnectionDeps } from "@/lib/shopify/connection";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import { createShopifyRepository } from "@/lib/shopify/repository";
import { AdminClientConfigError } from "@/lib/supabase/admin";

/** Production dependencies. Missing configuration becomes a friendly "not_configured". */
export function getShopifyDeps(): ConnectionDeps {
  try {
    return { config: getShopifyConfig(), repo: createShopifyRepository() };
  } catch (error) {
    if (error instanceof ShopifyConfigError || error instanceof AdminClientConfigError) {
      // Names of missing variables only — never values.
      console.error(`[shopify] not configured: ${error.message}`);
      throw new ShopifyFlowError("not_configured");
    }
    throw error;
  }
}

/** Log without secrets: error class + code only. */
export function logShopifyError(scope: string, error: unknown) {
  if (error instanceof ShopifyFlowError) console.warn(`[shopify] ${scope}: ${error.code}`);
  else if (error instanceof ShopifyApiError) console.warn(`[shopify] ${scope}: api ${error.kind} (${error.status ?? "-"})`);
  else console.error(`[shopify] ${scope}: ${error instanceof Error ? error.name : "unknown error"}`);
}

export function toFlowError(error: unknown, storeId?: string): ShopifyFlowError {
  if (error instanceof ShopifyFlowError) return error;
  return new ShopifyFlowError("unknown", { storeId });
}
