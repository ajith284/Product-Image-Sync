/**
 * Product matching rules (PROJECT_SPEC.md §6). Pure module: no Shopify, no I/O.
 *
 * A Google Drive product folder name matches a Shopify product when the
 * product's normalized title CONTAINS the normalized folder name.
 * SKU is never used. Nothing is ever selected automatically when several
 * products match — that goes to the Review Center.
 */

/**
 * Normalizes text for comparison only (never used to change Shopify data):
 * - Unicode NFC, so "é" typed two different ways compares equal (Drive
 *   names created on macOS are often decomposed)
 * - lowercase
 * - trim, and collapse any run of whitespace (incl. tabs / non-breaking
 *   spaces) into a single space
 * Punctuation, digits and other meaningful characters are kept.
 */
export function normalizeMatchText(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the normalized title contains the normalized folder/search name. */
export function titleMatches(title: string, name: string): boolean {
  const needle = normalizeMatchText(name);
  if (!needle) return false;
  return normalizeMatchText(title).includes(needle);
}

/** Keeps every product whose title matches. Order is preserved; nothing is chosen. */
export function filterMatchingProducts<T extends { title: string }>(name: string, products: readonly T[]): T[] {
  return products.filter((p) => titleMatches(p.title, name));
}

export type MatchStatus = "no_product_found" | "single_match" | "multiple_matches";

export type MatchResult<T> = {
  status: MatchStatus;
  /** ALL matching products. For multiple matches none is preferred over another. */
  matches: T[];
};

/**
 * Classifies the matches for a folder:
 * - 0 → `no_product_found` (Review Center; never create a product)
 * - 1 → `single_match` (a later sync phase may upload to it)
 * - 2+ → `multiple_matches` (Review Center; upload nothing, never guess)
 */
export function classifyMatches<T>(matches: readonly T[]): MatchResult<T> {
  const status: MatchStatus =
    matches.length === 0 ? "no_product_found" : matches.length === 1 ? "single_match" : "multiple_matches";
  return { status, matches: [...matches] };
}

/** filter + classify in one step. */
export function matchFolderToProducts<T extends { title: string }>(
  folderName: string,
  products: readonly T[],
): MatchResult<T> {
  return classifyMatches(filterMatchingProducts(folderName, products));
}
