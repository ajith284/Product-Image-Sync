import type { NextRequest } from "next/server";

import { appRedirect } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth";
import { handleCallback } from "@/lib/shopify/auth";
import { getShopifyDeps, logShopifyError, toFlowError } from "@/lib/shopify/runtime";

export const dynamic = "force-dynamic";

/**
 * Shopify OAuth redirect target (register it as an allowed redirect URL).
 * Tokens and codes never appear in the response: only a redirect to the
 * store page with a status/error CODE.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  // Absolute URL from configuration only (never from Host / X-Forwarded-* headers).
  const back = (path: string) => appRedirect(path, [{ name: "SHOPIFY_APP_URL", value: process.env.SHOPIFY_APP_URL }]);

  try {
    const result = await handleCallback(
      { query: request.nextUrl.searchParams, sessionUserId: user?.id ?? null },
      getShopifyDeps(),
    );
    return back(`/stores/${result.storeId}?shopify=${result.verified ? "connected" : "connected_unverified"}`);
  } catch (error) {
    logShopifyError("callback", error);
    const flow = toFlowError(error);
    return back(
      flow.storeId ? `/stores/${flow.storeId}?shopify_error=${flow.code}` : `/stores?shopify_error=${flow.code}`,
    );
  }
}
