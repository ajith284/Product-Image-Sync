import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { isValidShopDomain } from "@/lib/shopify/domain";
import type { ShopifyRepository } from "@/lib/shopify/repository";

/**
 * Shopify HTTPS webhooks: HMAC-SHA256 (base64) over the RAW body with the app's
 * client secret, timing-safe comparison, de-duplication by X-Shopify-Webhook-Id.
 */

export const HANDLED_TOPICS = [
  "app/uninstalled",
  // Mandatory compliance topics. This app stores no customer data, so the
  // customer topics only need acknowledging.
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
  input: { rawBody: string; headers: Headers },
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
    `sha256:${createHash("sha256").update(`${topic}\n${shop}\n${rawBody}`).digest("hex")}`;

  try {
    if (topic === "app/uninstalled") {
      const outcome = await deps.repo.handleAppUninstalled(webhookId, shop);
      return { status: 200, outcome };
    }
    const isNew = await deps.repo.recordWebhook(webhookId.slice(0, 200), topic.slice(0, 100), shop);
    return { status: 200, outcome: isNew ? `acknowledged:${topic}` : "duplicate" };
  } catch {
    return { status: 500, outcome: "error" };
  }
}
