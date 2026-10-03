"use client";

import {
  ArrowDownAZIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreVerticalIcon,
  SearchIcon,
  StoreIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { ReviewListItem } from "@/lib/data/sync";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

type StatusFilter =
  | "all"
  | "no_product_found"
  | "upload_failed"
  | "skipped"
  | "other";

type SortMode = "name_asc" | "name_desc" | "newest" | "store_asc";

const PAGE_SIZE = 10;

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "no_product_found", label: "No product found" },
  { key: "upload_failed", label: "Upload failed" },
  { key: "skipped", label: "Skipped" },
  { key: "other", label: "Other" },
];

function bucket(status: string): StatusFilter {
  if (status === "no_product_found") return "no_product_found";
  if (status === "upload_failed") return "upload_failed";
  if (status === "skipped") return "skipped";
  return "other";
}

function statusMeta(status: string) {
  if (status === "no_product_found") {
    return {
      label: "No product found",
      className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    };
  }
  if (status === "upload_failed") {
    return {
      label: "Upload failed",
      className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    };
  }
  if (status === "skipped") {
    return {
      label: "Skipped",
      className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    };
  }
  if (status === "multiple_matches") {
    return {
      label: "Multiple matches",
      className: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    };
  }
  return {
    label: status.replaceAll("_", " "),
    className: "bg-muted text-muted-foreground",
  };
}

function productName(item: ReviewListItem) {
  return item.drive_folder_name || item.shopify_product_title || "Unnamed product";
}

function sortLabel(mode: SortMode) {
  if (mode === "name_desc") return "Product Name (Z-A)";
  if (mode === "newest") return "Latest issue";
  if (mode === "store_asc") return "Store Name (A-Z)";
  return "Product Name (A-Z)";
}

function NumberCell({ value }: { value: number }) {
  return (
    <div className="rounded-md bg-muted/35 px-3 py-2 text-center font-semibold tabular-nums">
      {value}
    </div>
  );
}

export function ReviewTable({ items }: { items: ReviewListItem[] }) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [store, setStore] = useState("all");
  const [sort, setSort] = useState<SortMode>("name_asc");
  const [page, setPage] = useState(1);

  const stores = useMemo(
    () => [...new Set(items.map((item) => item.store_name))].sort((a, b) => a.localeCompare(b)),
    [items],
  );
  const categories = useMemo(
    () => [...new Set(items.map((item) => item.category_name))].sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const counts = useMemo(() => {
    const result: Record<StatusFilter, number> = {
      all: items.length,
      no_product_found: 0,
      upload_failed: 0,
      skipped: 0,
      other: 0,
    };
    for (const item of items) result[bucket(item.status)] += 1;
    return result;
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((item) => status === "all" || bucket(item.status) === status)
      .filter((item) => category === "all" || item.category_name === category)
      .filter((item) => store === "all" || item.store_name === store)
      .filter((item) => {
        if (!q) return true;
        return [
          productName(item),
          item.shopify_product_title,
          item.store_name,
          item.category_name,
          item.code_folder_name,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q));
      })
      .sort((a, b) => {
        if (sort === "name_desc") return productName(b).localeCompare(productName(a));
        if (sort === "newest") return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        if (sort === "store_asc") {
          return a.store_name.localeCompare(b.store_name) || productName(a).localeCompare(productName(b));
        }
        return productName(a).localeCompare(productName(b));
      });
  }, [category, items, search, sort, status, store]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  const chooseStatus = (next: StatusFilter) => {
    setStatus(next);
    setPage(1);
  };
  const chooseCategory = (next: string) => {
    setCategory(next);
    setPage(1);
  };
  const chooseStore = (next: string) => {
    setStore(next);
    setPage(1);
  };

  const pages = Array.from({ length: pageCount }, (_, index) => index + 1).filter(
    (number) =>
      pageCount <= 5 ||
      number === 1 ||
      number === pageCount ||
      Math.abs(number - safePage) <= 1,
  );

  return (
    <div className="grid gap-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Review</h1>
          <p className="text-muted-foreground">
            Products that were held back or had an upload problem during a real sync.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-3 xl:w-[620px]">
          <div className="relative sm:col-span-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search product name..."
              className="pl-9"
            />
          </div>
          <select
            value={category}
            onChange={(event) => chooseCategory(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Filter by category"
          >
            <option value="all">All Categories</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={store}
            onChange={(event) => chooseStore(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Filter by store"
          >
            <option value="all">All Stores</option>
            {stores.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => {
            const active = status === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => chooseStatus(filter.key)}
                className={
                  active
                    ? "inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-background"
                    : "inline-flex h-9 items-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {filter.label}
                <span
                  className={
                    active
                      ? "rounded-full bg-background/15 px-2 py-0.5 text-xs"
                      : "rounded-full bg-background px-2 py-0.5 text-xs text-foreground"
                  }
                >
                  {counts[filter.key]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative w-full sm:w-64">
          <ArrowDownAZIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as SortMode);
              setPage(1);
            }}
            className="h-9 w-full appearance-none rounded-md border border-input bg-background pl-9 pr-8 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Sort review items"
          >
            <option value="name_asc">Sort by Product Name (A-Z)</option>
            <option value="name_desc">Sort by Product Name (Z-A)</option>
            <option value="newest">Sort by Latest Issue</option>
            <option value="store_asc">Sort by Store Name (A-Z)</option>
          </select>
          <span className="sr-only">{sortLabel(sort)}</span>
        </div>
      </div>

      {items.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="font-medium">No items require review.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Product matching problems, skipped products, and upload failures will appear here.
          </p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="font-medium">No products match these filters.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Change the status, category, store, or search term.
          </p>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden p-0 shadow-sm">
            <div className="overflow-x-auto">
              <div className="min-w-[1120px] p-3">
                <div className="grid grid-cols-[2.1fr_1.05fr_1.35fr_.72fr_.72fr_.72fr_.72fr_1.25fr_44px] items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <div>Product Name</div>
                  <div>Category</div>
                  <div>Store</div>
                  <div className="text-center">Images Found</div>
                  <div className="text-center">Uploaded</div>
                  <div className="text-center">Skipped</div>
                  <div className="text-center">Failed</div>
                  <div>Status</div>
                  <div />
                </div>

                <div className="grid gap-2">
                  {visible.map((item) => {
                    const meta = statusMeta(item.status);
                    return (
                      <div
                        key={item.id}
                        className="grid grid-cols-[2.1fr_1.05fr_1.35fr_.72fr_.72fr_.72fr_.72fr_1.25fr_44px] items-center gap-2 rounded-xl border bg-card px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{productName(item)}</div>
                          {item.error_message ? (
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {item.error_message}
                            </div>
                          ) : null}
                        </div>
                        <div>
                          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                            {item.category_name}
                          </span>
                        </div>
                        <div className="truncate text-sm">{item.store_name}</div>
                        <NumberCell value={item.images_found} />
                        <NumberCell value={item.images_uploaded} />
                        <NumberCell value={item.images_skipped} />
                        <NumberCell value={item.images_failed} />
                        <div>
                          <span
                            className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${meta.className}`}
                          >
                            {meta.label}
                          </span>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label={`Actions for ${productName(item)}`}
                            >
                              <MoreVerticalIcon className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/stores/${item.store_id}`}>
                                <StoreIcon />
                                Open store
                              </Link>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Card>

          <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <div>
              Showing {start + 1}–{Math.min(start + PAGE_SIZE, filtered.length)} of {filtered.length} products
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-9"
                disabled={safePage <= 1}
                onClick={() => setPage(Math.max(1, safePage - 1))}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              {pages.map((number, index) => {
                const previous = pages[index - 1];
                return (
                  <span key={number} className="contents">
                    {previous && number - previous > 1 ? (
                      <span className="px-1 text-muted-foreground">…</span>
                    ) : null}
                    <Button
                      variant={number === safePage ? "default" : "outline"}
                      size="icon"
                      className="size-9"
                      onClick={() => setPage(number)}
                    >
                      {number}
                    </Button>
                  </span>
                );
              })}
              <Button
                variant="outline"
                size="icon"
                className="size-9"
                disabled={safePage >= pageCount}
                onClick={() => setPage(Math.min(pageCount, safePage + 1))}
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
