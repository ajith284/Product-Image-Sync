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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type Filter = "all" | ProductReviewStatus;
type Sort = "az" | "za" | "newest" | "oldest";

const STATUS_META: Record<
  ProductReviewStatus,
  { label: string; className: string }
> = {
  completed: {
    label: "Completed",
    className: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  },
  no_product_found: {
    label: "No product found",
    className: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  },
  multiple_matches: {
    label: "Multiple matches",
    className: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  },
  upload_failed: {
    label: "Upload failed",
    className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  skipped: {
    label: "Skipped",
    className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  other: {
    label: "Other",
    className: "bg-muted text-muted-foreground",
  },
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "completed", label: "Completed" },
  { key: "no_product_found", label: "No product found" },
  { key: "multiple_matches", label: "Multiple matches" },
  { key: "upload_failed", label: "Upload failed" },
  { key: "skipped", label: "Skipped" },
  { key: "other", label: "Other" },
];

const PAGE_SIZE = 10;

function productName(item: ProductReviewItem) {
  return item.drive_folder_name ?? item.shopify_product_title ?? "Unnamed product";
}

function timestamp(item: ProductReviewItem) {
  return new Date(item.updated_at).getTime();
}

export function ReviewProductsTable({ items }: { items: ProductReviewItem[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [store, setStore] = useState("all");
  const [sort, setSort] = useState<Sort>("az");
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const out: Record<ProductReviewStatus, number> = {
      completed: 0,
      no_product_found: 0,
      multiple_matches: 0,
      upload_failed: 0,
      skipped: 0,
      other: 0,
    };
    for (const item of items) out[item.review_status] += 1;
    return out;
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
      [...new Set(items.map((item) => item.store_name))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((item) => {
        if (filter !== "all" && item.review_status !== filter) return false;
        if (category !== "all" && item.category_name !== category) return false;
        if (store !== "all" && item.store_name !== store) return false;
        if (
          q &&
          !productName(item).toLowerCase().includes(q) &&
          !item.store_name.toLowerCase().includes(q) &&
          !item.category_name.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sort === "az") return productName(a).localeCompare(productName(b));
        if (sort === "za") return productName(b).localeCompare(productName(a));
        if (sort === "newest") return timestamp(b) - timestamp(a);
        return timestamp(a) - timestamp(b);
      });
  }, [category, filter, items, search, sort, store]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const pageItems = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const changeFilter = (value: Filter) => {
    setFilter(value);
    setPage(1);
  };

  const rangeStart = filtered.length ? (currentPage - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, filtered.length);

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-wrap gap-2">
          {FILTERS.map((item) => {
            const count = item.key === "all" ? items.length : counts[item.key];
            const active = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => changeFilter(item.key)}
                className={
                  active
                    ? "inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-background"
                    : "inline-flex h-9 items-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {item.label}
                <span
                  className={
                    active
                      ? "rounded-full bg-background/15 px-1.5 text-xs"
                      : "rounded-full bg-background px-1.5 text-xs text-foreground"
                  }
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 md:flex-row">
          <div className="relative md:w-72">
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
            className="h-9 min-w-44 rounded-md border border-input bg-background px-3 text-sm"
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
            onChange={(event) => {
              setStore(event.target.value);
              setPage(1);
            }}
            className="h-9 min-w-40 rounded-md border border-input bg-background px-3 text-sm"
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

      <div className="flex justify-end">
        <div className="relative w-full sm:w-64">
          <ArrowDownAZIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setPage(1);
            }}
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm"
            aria-label="Sort products"
          >
            <option value="az">Sort by Product Name (A–Z)</option>
            <option value="za">Sort by Product Name (Z–A)</option>
            <option value="newest">Last Updated (Newest)</option>
            <option value="oldest">Last Updated (Oldest)</option>
          </select>
        </div>
      </div>

      <Card className="overflow-hidden p-0 shadow-sm">
        <div className="overflow-x-auto p-3">
          <Table className="min-w-[1120px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[260px]">Product Name</TableHead>
                <TableHead className="w-[140px]">Category</TableHead>
                <TableHead className="w-[160px]">Store</TableHead>
                <TableHead className="text-center">Images Found</TableHead>
                <TableHead className="text-center">Uploaded</TableHead>
                <TableHead className="text-center">Skipped</TableHead>
                <TableHead className="text-center">Failed</TableHead>
                <TableHead className="w-[170px]">Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.length ? (
                pageItems.map((item) => {
                  const status = STATUS_META[item.review_status];
                  return (
                    <TableRow key={item.id} className="group">
                      <TableCell className="font-semibold">
                        {productName(item)}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex rounded-full bg-muted px-3 py-1 text-xs">
                          {item.category_name}
                        </span>
                      </TableCell>
                      <TableCell>{item.store_name}</TableCell>
                      <TableCell className="text-center font-semibold tabular-nums">
                        {item.images_found}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {item.images_uploaded}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {item.images_skipped}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {item.images_failed}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex min-w-28 justify-center rounded-full px-3 py-1.5 text-xs font-medium ${status.className}`}
                        >
                          {status.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
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
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={9} className="h-32 text-center">
                    <p className="font-medium">No products match this view.</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Change the status, category, store, or search filter.
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>
          Showing {rangeStart}–{rangeEnd} of {filtered.length} products
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={currentPage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            aria-label="Previous page"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>
          {Array.from({ length: pages }, (_, index) => index + 1)
            .filter(
              (value) =>
                pages <= 7 ||
                value === 1 ||
                value === pages ||
                Math.abs(value - currentPage) <= 1,
            )
            .map((value) => (
              <Button
                key={value}
                variant={value === currentPage ? "default" : "outline"}
                size="icon"
                className="size-9"
                onClick={() => setPage(value)}
              >
                {value}
              </Button>
            ))}
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={currentPage >= pages}
            onClick={() => setPage((value) => Math.min(pages, value + 1))}
            aria-label="Next page"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
