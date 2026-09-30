import { NextResponse, type NextRequest } from "next/server";

import { getShopifyDeps } from "@/lib/shopify/runtime";
import { handleShopifyWebhook } from "@/lib/shopify/webhooks";

export const dynamic = "force-dynamic";

/**
 * Shopify webhook endpoint (app/uninstalled + mandatory compliance topics).
 * Public route (no user session) — authenticity comes from the HMAC.
 * Responds quickly; never echoes payloads or secrets.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text(); // raw body is required for HMAC verification

  let deps: ReturnType<typeof getShopifyDeps>;
  try {
    deps = getShopifyDeps();
  } catch {
    return new NextResponse(null, { status: 500 });
  }

  const result = await handleShopifyWebhook(
    { rawBody, headers: request.headers },
    { clientSecret: deps.config.clientSecret, repo: deps.repo },
  );
  if (result.status !== 200) console.warn(`[shopify] webhook ${result.outcome}`);
  return new NextResponse(null, { status: result.status });
}
