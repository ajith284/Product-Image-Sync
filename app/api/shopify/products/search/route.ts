import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { classifyMatches } from "@/lib/matching/product-match";
import { ShopifyApiError } from "@/lib/shopify/client";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import { MAX_SEARCH_TERM_LENGTH, searchProducts } from "@/lib/shopify/products";
import { getShopifyDeps, logShopifyError } from "@/lib/shopify/runtime";
import { authorizeProductSearch } from "@/lib/shopify/search-access";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  storeId: z.string(),
  searchTerm: z
    .string()
    .trim()
    .min(1, "Enter a product name to search for.")
    .max(MAX_SEARCH_TERM_LENGTH, `Use at most ${MAX_SEARCH_TERM_LENGTH} characters.`),
});

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/shopify/products/search  { storeId, searchTerm }
 * READ-ONLY. Returns every product whose title contains the term (any status)
 * with safe fields only — never tokens or secrets.
 */
export async function POST(request: NextRequest) {
  // JSON only: a plain cross-site form post can't reach this handler.
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Unsupported request." }, 415);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "Unsupported request." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, 400);
  }
  const { storeId, searchTerm } = parsed.data;

  const access = await authorizeProductSearch(storeId);
  if (!access.ok) return json({ error: access.error }, access.status);

  try {
    const result = await searchProducts({ storeId: access.storeId, searchTerm }, getShopifyDeps());
    const { status } = classifyMatches(result.products);
    return json({
      searchTerm,
      matchStatus: status,
      count: result.products.length,
      truncated: result.truncated,
      products: result.products,
    });
  } catch (error) {
    logShopifyError("product-search", error);
    if (error instanceof ShopifyFlowError) {
      const status = error.code === "not_configured" ? 503 : 409;
      return json({ error: error.userMessage }, status);
    }
    if (error instanceof ShopifyApiError) {
      return json({ error: error.userMessage }, error.retryable ? 503 : 502);
    }
    return json({ error: "Something went wrong while searching Shopify. Please try again." }, 500);
  }
}
