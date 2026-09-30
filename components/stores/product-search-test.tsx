"use client";

import { AlertTriangleIcon, FlaskConicalIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Safe product fields returned by /api/shopify/products/search. */
type ProductRow = {
  id: string;
  legacyResourceId: string;
  title: string;
  handle: string;
  status: string;
  vendor: string;
  productType: string;
  mediaCount: number | null;
};

type SearchResponse = {
  searchTerm: string;
  matchStatus: "no_product_found" | "single_match" | "multiple_matches";
  count: number;
  truncated: boolean;
  products: ProductRow[];
};

const MATCH_LABEL: Record<SearchResponse["matchStatus"], string> = {
  no_product_found: "No product found",
  single_match: "1 match",
  multiple_matches: "Multiple matches — would go to Review Center (nothing is chosen automatically)",
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  ACTIVE: "default",
  DRAFT: "secondary",
  ARCHIVED: "outline",
  UNLISTED: "outline",
};

/**
 * TEMPORARY development tool (Prompt 5): searches this store's Shopify
 * products with the same title-matching rules the image sync will use.
 * Read-only — nothing in Shopify is changed.
 */
export function ProductSearchTest({ storeId }: { storeId: string }) {
  const [term, setTerm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/shopify/products/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, searchTerm: term }),
      });
      const body = (await res.json().catch(() => null)) as (SearchResponse & { error?: string }) | null;
      if (!res.ok || !body || body.error) {
        setResult(null);
        setError(body?.error ?? "Search failed. Please try again.");
        return;
      }
      setResult(body);
    } catch {
      setResult(null);
      setError("We couldn't reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <FlaskConicalIcon className="size-4" /> Shopify Product Search Test
          <Badge variant="outline">Development tool</Badge>
        </CardTitle>
        <CardDescription>
          Finds products whose title contains your text (any status), using the same rules as folder matching.
          Read-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="product-search">Search product</Label>
            <Input
              id="product-search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="e.g. Milano"
              maxLength={120}
              autoComplete="off"
            />
          </div>
          <Button type="submit" disabled={pending || term.trim().length === 0}>
            {pending ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
            Search
          </Button>
        </form>

        {error ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {result ? (
          <div className="grid gap-3" aria-live="polite">
            <p className="text-sm">
              <span className="font-medium">
                {result.count} {result.count === 1 ? "product" : "products"}
              </span>{" "}
              for “{result.searchTerm}” · <span className="text-muted-foreground">{MATCH_LABEL[result.matchStatus]}</span>
            </p>
            {result.truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing matches from the first 500 Shopify results. Use a more specific name to narrow it down.
              </p>
            ) : null}
            {result.products.length > 0 ? (
              <ul className="divide-y rounded-lg border">
                {result.products.map((p) => (
                  <li key={p.id} className="grid gap-1 p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4">
                    <div className="min-w-0">
                      <p className="font-medium break-words">{p.title}</p>
                      <p className="text-xs break-all text-muted-foreground">
                        Product ID: {p.legacyResourceId} · {p.id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[p.handle, p.vendor, p.productType].filter(Boolean).join(" · ")}
                        {p.mediaCount !== null ? ` · ${p.mediaCount} media` : ""}
                      </p>
                    </div>
                    <div>
                      <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>Status: {p.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
