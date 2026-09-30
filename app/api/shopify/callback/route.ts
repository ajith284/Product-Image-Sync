import { NextResponse, type NextRequest } from "next/server";

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
  const back = (path: string) => {
    const res = NextResponse.redirect(new URL(path, request.nextUrl.origin));
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };

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
