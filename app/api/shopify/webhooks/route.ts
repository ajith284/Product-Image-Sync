import { NextResponse, type NextRequest } from "next/server";

import { getShopifyDeps } from "@/lib/shopify/runtime";
import { handleShopifyWebhook, readLimitedBody } from "@/lib/shopify/webhooks";

export const dynamic = "force-dynamic";

/**
 * Shopify webhook endpoint (app/uninstalled + mandatory compliance topics).
 * Public route (no user session) — authenticity comes from the HMAC.
 * Responds quickly; never echoes payloads or secrets.
 * The body is size-limited (MAX_WEBHOOK_BODY_BYTES) BEFORE anything else: oversized → 413.
 */
export async function POST(request: NextRequest) {
  // Raw bytes (not request.text()) are what Shopify signed; read with a hard size limit.
  const read = await readLimitedBody(request);
  if (!read.ok) {
    console.warn(`[shopify] webhook ${read.status === 413 ? "payload_too_large" : "unreadable_body"}`);
    return new NextResponse(null, { status: read.status });
  }
  const rawBody = read.body;

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
