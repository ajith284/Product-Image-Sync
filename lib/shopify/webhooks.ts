import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { readLimitedBody as readBoundedBody, type LimitedBody } from "@/lib/http/limited-body";
import { isValidShopDomain } from "@/lib/shopify/domain";
import type { ShopifyRepository } from "@/lib/shopify/repository";

/**
 * Shopify HTTPS webhooks: HMAC-SHA256 (base64) over the RAW body with the app's
 * client secret, timing-safe comparison, de-duplication by X-Shopify-Webhook-Id.
 */

/**
 * Maximum accepted webhook body: 1 MiB (Prompt 14C.1).
 *
 * Shopify's webhook docs (checked 2026-10-02: delivery structure, HTTPS delivery,
 * privacy-law compliance) document no maximum payload size. This app only handles
 * app/uninstalled (a Shop resource, a few KB) and the compliance topics
 * (customers/data_request, customers/redact, shop/redact: IDs, an email, a phone and
 * order-id arrays — even ~50,000 order ids stay well under 1 MiB). 1 MiB is therefore
 * generous for real deliveries while bounding the memory an unauthenticated caller can
 * make us hold before the HMAC is checked. The Next.js proxy's own buffer limit
 * (proxyClientMaxBodySize, default 10 MB) silently TRUNCATES instead of rejecting, so it
 * is not relied on here.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export type { LimitedBody };

/** Raw webhook body, bounded by MAX_WEBHOOK_BODY_BYTES (see lib/http/limited-body.ts). */
export function readLimitedBody(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<LimitedBody> {
  return readBoundedBody(request, maxBytes);
}

export const HANDLED_TOPICS = [
  "app/uninstalled",
  // Mandatory compliance topics. The app requests no customer scopes and stores no
  // customer data, so customers/data_request and customers/redact are acknowledged and
  // recorded only; shop/redact erases the shop's Shopify data (Prompt 14F).
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export function verifyWebhookHmac(rawBody: string | Buffer, hmacHeader: string | null, clientSecret: string): boolean {
  if (!hmacHeader || !/^[A-Za-z0-9+/]+={0,2}$/.test(hmacHeader)) return false;
  const expected = createHmac("sha256", clientSecret).update(rawBody).digest();
  const received = Buffer.from(hmacHeader, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export type WebhookResult = { status: 200 | 400 | 401 | 500; outcome: string };

/**
 * Process one webhook delivery. Returns the HTTP status to send:
 * 401 invalid HMAC (required for compliance webhooks), 400 malformed,
 * 200 processed / duplicate / ignored, 500 on server failure so Shopify retries.
 */
export async function handleShopifyWebhook(
  input: { rawBody: string | Buffer; headers: Headers },
  deps: { clientSecret: string; repo: ShopifyRepository },
): Promise<WebhookResult> {
  const { rawBody, headers } = input;

  if (!verifyWebhookHmac(rawBody, headers.get("x-shopify-hmac-sha256"), deps.clientSecret)) {
    return { status: 401, outcome: "invalid_hmac" };
  }

  const topic = headers.get("x-shopify-topic") ?? "";
  const shop = (headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  if (!topic || !isValidShopDomain(shop)) return { status: 400, outcome: "malformed" };

  // Prefer the delivery id; fall back to a digest of topic+shop+body (still stable across retries).
  const webhookId =
    headers.get("x-shopify-webhook-id") ??
    `sha256:${createHash("sha256").update(`${topic}\n${shop}\n`).update(rawBody).digest("hex")}`;

  try {
    if (topic === "app/uninstalled") {
      const outcome = await deps.repo.handleAppUninstalled(webhookId, shop);
      return { status: 200, outcome };
    }
    if (topic === "shop/redact") {
      const outcome = await deps.repo.handleShopRedact(webhookId.slice(0, 200), shop);
      return { status: 200, outcome: outcome === "duplicate" ? "duplicate" : `shop_redact:${outcome}` };
    }
    const isNew = await deps.repo.recordWebhook(webhookId.slice(0, 200), topic.slice(0, 100), shop);
    return { status: 200, outcome: isNew ? `acknowledged:${topic}` : "duplicate" };
  } catch {
    return { status: 500, outcome: "error" };
  }
}
