"use client";

import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreVerticalIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  StoreIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type {
  ProductReviewItem,
  ProductReviewStatus,
} from "@/lib/data/sync";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

type Filter = "all" | ProductReviewStatus;
type Sort = "name_asc" | "name_desc" | "updated_desc" | "updated_asc";

const PAGE_SIZE = 10;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "completed", label: "Completed" },
  { key: "no_product_found", label: "No product found" },
  { key: "upload_failed", label: "Upload failed" },
  { key: "skipped", label: "Skipped" },
  { key: "other", label: "Other" },
];

const STATUS_META: Record<
  ProductReviewStatus,
  { label: string; className: string }
> = {
  completed: {
    label: "Completed",
    className:
      "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  },
  no_product_found: {
    label: "No product found",
    className: "bg-muted text-muted-foreground",
  },
  upload_failed: {
    label: "Upload failed",
    className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  skipped: {
    label: "Skipped",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  other: {
    label: "Other",
    className:
      "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  },
};

function MetricCell({ value }: { value: number }) {
  return (
    <div className="flex h-11 items-center justify-center rounded-md bg-muted/35 font-semibold tabular-nums">
      {value}
    </div>
  );
}

function pageNumbers(current: number, total: number) {
  if (total <= 5) return Array.from({ length: total }, (_, index) => index + 1);
  if (current <= 3) return [1, 2, 3, 4, 5];
  if (current >= total - 2)
    return [total - 4, total - 3, total - 2, total - 1, total];
  return [current - 2, current - 1, current, current + 1, current + 2];
}

export function ReviewProductsOverview({
  items,
}: {
  items: ProductReviewItem[];
}) {
  const [status, setStatus] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [store, setStore] = useState("all");
  const [sort, setSort] = useState<Sort>("name_asc");
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const result: Record<ProductReviewStatus, number> = {
      completed: 0,
      no_product_found: 0,
      upload_failed: 0,
      skipped: 0,
      other: 0,
    };
    for (const item of items) result[item.status] += 1;
    return result;
  }, [items]);

  const categories = useMemo(
    () =>
      [...new Set(items.map((item) => item.category_name))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const stores = useMemo(
    () =>
      [...new Map(items.map((item) => [item.store_id, item.store_name])).entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter(
        (item) =>
          (status === "all" || item.status === status) &&
          (category === "all" || item.category_name === category) &&
          (store === "all" || item.store_id === store) &&
          (!q ||
            item.product_name.toLowerCase().includes(q) ||
            item.shopify_product_title?.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        if (sort === "name_asc")
          return a.product_name.localeCompare(b.product_name);
        if (sort === "name_desc")
          return b.product_name.localeCompare(a.product_name);
        const delta =
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        return sort === "updated_desc" ? delta : -delta;
      });
  }, [category, items, search, sort, status, store]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  const setFilter = (key: Filter) => {
    setStatus(key);
    setPage(1);
  };

  const filterCount = (key: Filter) =>
    key === "all" ? items.length : counts[key];

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2 xl:flex-nowrap">
          {FILTERS.map((filter) => {
            const active = status === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => setFilter(filter.key)}
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
                      ? "rounded-full bg-background/15 px-1.5 text-xs"
                      : "rounded-full bg-background px-1.5 text-xs text-foreground"
                  }
                >
                  {filterCount(filter.key)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 md:flex-row">
          <div className="relative min-w-0 md:w-72">
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
            onChange={(event) => {
              setCategory(event.target.value);
              setPage(1);
            }}
            className="h-9 min-w-44 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Filter by category"
          >
            <option value="all">All Categories</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={store}
            onChange={(event) => {
              setStore(event.target.value);
              setPage(1);
            }}
            className="h-9 min-w-44 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Filter by store"
          >
            <option value="all">All Stores</option>
            {stores.map((value) => (
              <option key={value.id} value={value.id}>
                {value.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-end">
        <div className="relative w-full sm:w-64">
          <SlidersHorizontalIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setPage(1);
            }}
            className="h-9 w-full appearance-none rounded-md border border-input bg-background pl-9 pr-8 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Sort products"
          >
            <option value="name_asc">Sort by Product Name (A-Z)</option>
            <option value="name_desc">Sort by Product Name (Z-A)</option>
            <option value="updated_desc">Last Updated (Newest)</option>
            <option value="updated_asc">Last Updated (Oldest)</option>
          </select>
        </div>
      </div>

      <Card className="overflow-hidden p-0 shadow-sm">
        <div className="overflow-x-auto p-3">
          <div className="min-w-[1080px]">
            <div className="grid grid-cols-[2.2fr_1.1fr_1.2fr_.75fr_.75fr_.75fr_.75fr_1.25fr_44px] items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
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

            {visible.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-lg border">
                <CheckCircle2Icon className="mb-3 size-7 text-muted-foreground" />
                <p className="font-medium">No products match this view.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Change the status, category, store, or search filter.
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                {visible.map((item) => {
                  const meta = STATUS_META[item.status];
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-[2.2fr_1.1fr_1.2fr_.75fr_.75fr_.75fr_.75fr_1.25fr_44px] items-center gap-2 rounded-xl border px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold">
                          {item.product_name}
                        </div>
                        {item.error_message ? (
                          <div className="mt-0.5 truncate text-xs text-destructive">
                            {item.error_message}
                          </div>
                        ) : null}
                      </div>
                      <div>
                        <span className="inline-flex rounded-full bg-muted px-3 py-1 text-xs">
                          {item.category_name}
                        </span>
                      </div>
                      <div className="truncate text-sm">{item.store_name}</div>
                      <MetricCell value={item.images_found} />
                      <MetricCell value={item.images_uploaded} />
                      <MetricCell value={item.images_skipped} />
                      <MetricCell value={item.images_failed} />
                      <div>
                        <span
                          className={`inline-flex min-w-28 items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium ${meta.className}`}
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
                            aria-label={`Actions for ${item.product_name}`}
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
            )}
          </div>
        </div>
      </Card>

      <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div>
          {filtered.length === 0
            ? "Showing 0 products"
            : `Showing ${start + 1}–${Math.min(
                start + PAGE_SIZE,
                filtered.length,
              )} of ${filtered.length} products`}
        </div>

        {pageCount > 1 ? (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={safePage === 1}
              onClick={() => setPage(Math.max(1, safePage - 1))}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            {pageNumbers(safePage, pageCount).map((number) => (
              <Button
                key={number}
                variant={number === safePage ? "default" : "outline"}
                size="icon"
                className="size-9"
                onClick={() => setPage(number)}
              >
                {number}
              </Button>
            ))}
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              disabled={safePage === pageCount}
              onClick={() => setPage(Math.min(pageCount, safePage + 1))}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
