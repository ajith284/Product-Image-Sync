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
  ReviewProductFilterStatus,
  ReviewProductItem,
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

type Filter = "all" | ReviewProductFilterStatus;
type Sort = "name_asc" | "name_desc" | "newest";

const PAGE_SIZE = 10;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "completed", label: "Completed" },
  { key: "no_product_found", label: "No product found" },
  { key: "upload_failed", label: "Upload failed" },
  { key: "skipped", label: "Skipped" },
  { key: "other", label: "Other" },
];

const STATUS_CLASS: Record<ReviewProductFilterStatus, string> = {
  completed:
    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  no_product_found:
    "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  upload_failed:
    "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  skipped:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  other:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

function CountCell({ value }: { value: number }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2 text-center font-semibold tabular-nums">
      {value}
    </div>
  );
}

function StatusBadge({ item }: { item: ReviewProductItem }) {
  return (
    <span
      className={`inline-flex min-w-28 items-center justify-center rounded-full px-3 py-1.5 text-xs font-medium ${STATUS_CLASS[item.filter_status]}`}
    >
      {item.status_label}
    </span>
  );
}

export function ReviewProductsTable({
  items,
}: {
  items: ReviewProductItem[];
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [store, setStore] = useState("all");
  const [sort, setSort] = useState<Sort>("name_asc");
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const map: Record<ReviewProductFilterStatus, number> = {
      completed: 0,
      no_product_found: 0,
      upload_failed: 0,
      skipped: 0,
      other: 0,
    };
    for (const item of items) map[item.filter_status] += 1;
    return map;
  }, [items]);

  const categories = useMemo(
    () =>
      [...new Set(items.map((item) => item.category_name).filter(Boolean) as string[])]
        .sort((a, b) => a.localeCompare(b)),
    [items],
  );

  const stores = useMemo(
    () =>
      [...new Set(items.map((item) => item.store_name))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((item) => {
        if (filter !== "all" && item.filter_status !== filter) return false;
        if (category !== "all" && item.category_name !== category) return false;
        if (store !== "all" && item.store_name !== store) return false;
        if (
          q &&
          !item.product_name.toLowerCase().includes(q) &&
          !item.drive_folder_name?.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sort === "name_asc") {
          return a.product_name.localeCompare(b.product_name);
        }
        if (sort === "name_desc") {
          return b.product_name.localeCompare(a.product_name);
        }
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      });
  }, [category, filter, items, search, sort, store]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  const setFilterAndReset = (value: Filter) => {
    setFilter(value);
    setPage(1);
  };

  const from = filtered.length ? start + 1 : 0;
  const to = Math.min(start + PAGE_SIZE, filtered.length);

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((entry) => {
            const count = entry.key === "all" ? items.length : counts[entry.key];
            const active = filter === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setFilterAndReset(entry.key)}
                className={
                  active
                    ? "inline-flex h-9 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-background"
                    : "inline-flex h-9 items-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                }
              >
                {entry.label}
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

        <div className="flex flex-col gap-2 lg:flex-row">
          <div className="relative lg:w-72">
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
            className="h-9 min-w-44 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
        <div className="relative w-full sm:w-60">
          <ArrowDownAZIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setPage(1);
            }}
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Sort products"
          >
            <option value="name_asc">Sort by Product Name (A–Z)</option>
            <option value="name_desc">Sort by Product Name (Z–A)</option>
            <option value="newest">Sort by Latest Status</option>
          </select>
        </div>
      </div>

      <Card className="overflow-hidden p-0 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse">
            <thead>
              <tr className="border-b bg-muted/15 text-left text-xs font-medium text-muted-foreground">
                <th className="px-5 py-4">Product Name</th>
                <th className="px-4 py-4">Category</th>
                <th className="px-4 py-4">Store</th>
                <th className="px-3 py-4 text-center">Images Found</th>
                <th className="px-3 py-4 text-center">Uploaded</th>
                <th className="px-3 py-4 text-center">Skipped</th>
                <th className="px-3 py-4 text-center">Failed</th>
                <th className="px-4 py-4">Status</th>
                <th className="w-12 px-3 py-4" />
              </tr>
            </thead>
            <tbody>
              {visible.length ? (
                visible.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b last:border-b-0 hover:bg-muted/15"
                  >
                    <td className="px-5 py-3">
                      <div className="font-semibold">{item.product_name}</div>
                      {item.drive_folder_name &&
                      item.drive_folder_name !== item.product_name ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Drive: {item.drive_folder_name}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full bg-muted px-3 py-1 text-xs">
                        {item.category_name ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">{item.store_name}</td>
                    <td className="px-3 py-3">
                      <CountCell value={item.images_found} />
                    </td>
                    <td className="px-3 py-3">
                      <CountCell value={item.images_uploaded} />
                    </td>
                    <td className="px-3 py-3">
                      <CountCell value={item.images_skipped} />
                    </td>
                    <td className="px-3 py-3">
                      <CountCell value={item.images_failed} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge item={item} />
                    </td>
                    <td className="px-3 py-3 text-right">
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
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={9} className="px-6 py-16 text-center">
                    <div className="font-medium">No products found.</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Product sync results will appear inside this table when available.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {from}–{to} of {filtered.length} products
        </p>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={safePage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            aria-label="Previous page"
          >
            <ChevronLeftIcon className="size-4" />
          </Button>

          {Array.from({ length: Math.min(totalPages, 5) }, (_, index) => {
            let number = index + 1;
            if (totalPages > 5 && safePage > 3) {
              number = Math.min(totalPages - 4 + index, safePage - 2 + index);
            }
            const active = number === safePage;
            return (
              <Button
                key={number}
                type="button"
                variant={active ? "default" : "outline"}
                size="icon"
                className="size-9"
                onClick={() => setPage(number)}
              >
                {number}
              </Button>
            );
          })}

          <Button
            variant="outline"
            size="icon"
            className="size-9"
            disabled={safePage >= totalPages}
            onClick={() =>
              setPage((value) => Math.min(totalPages, value + 1))
            }
            aria-label="Next page"
          >
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
