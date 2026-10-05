"use client";

import {
  ArrowDownAZIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  MoreVerticalIcon,
  SearchIcon,
  StoreIcon,
  XCircleIcon,
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
  { key: "all", label: "All products" },
  { key: "completed", label: "Completed" },
  { key: "no_product_found", label: "No product found" },
  { key: "failed", label: "Failed" },
];

function statusClass(item: ReviewProductItem) {
  if (item.filter_status === "completed") {
    return "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300";
  }
  if (item.filter_status === "no_product_found") {
    return "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300";
  }
  if (item.status_label === "Skipped") {
    return "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
  }
  if (item.status_label === "Multiple matches") {
    return "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300";
  }
  return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
}

function StatusBadge({ item }: { item: ReviewProductItem }) {
  const Icon =
    item.filter_status === "completed"
      ? CheckCircle2Icon
      : item.filter_status === "no_product_found"
        ? InfoIcon
        : XCircleIcon;

  return (
    <span
      className={`inline-flex min-w-36 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${statusClass(item)}`}
    >
      <Icon className="size-4" />
      {item.status_label}
    </span>
  );
}

function CountCell({ value }: { value: number }) {
  return (
    <div className="rounded-md bg-muted/35 px-3 py-2 text-center font-medium tabular-nums">
      {value}
    </div>
  );
}

export function ReviewProductsTable({ items }: { items: ReviewProductItem[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<Sort>("name_asc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const counts = useMemo(() => {
    const map: Record<ReviewProductFilterStatus, number> = {
      completed: 0,
      no_product_found: 0,
      failed: 0,
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return items
      .filter((item) => {
        if (filter !== "all" && item.filter_status !== filter) return false;
        if (category !== "all" && item.category_name !== category) return false;
        if (
          q &&
          !item.product_name.toLowerCase().includes(q) &&
          !item.drive_folder_name?.toLowerCase().includes(q) &&
          !item.store_name.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sort === "name_asc") return a.product_name.localeCompare(b.product_name);
        if (sort === "name_desc") return b.product_name.localeCompare(a.product_name);
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
  }, [category, filter, items, search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const visibleIds = visible.map((item) => item.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const setFilterAndReset = (value: Filter) => {
    setFilter(value);
    setPage(1);
  };

  const toggleAllVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const footerText =
    filtered.length > PAGE_SIZE
      ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length} products`
      : `${filtered.length} ${filtered.length === 1 ? "product" : "products"}`;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 xl:grid-cols-[minmax(320px,1.6fr)_minmax(190px,.75fr)_minmax(190px,.75fr)_minmax(240px,.9fr)]">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search products..."
            className="h-12 pl-12 text-base"
          />
        </div>

        <select
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setPage(1);
          }}
          className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="Filter by product category"
        >
          <option value="all">Product category</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <select
          value={filter}
          onChange={(event) => setFilterAndReset(event.target.value as Filter)}
          className="h-12 w-full rounded-lg border border-input bg-background px-4 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="completed">Completed</option>
          <option value="no_product_found">No product found</option>
          <option value="failed">Failed</option>
        </select>

        <div className="relative">
          <ArrowDownAZIcon className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setPage(1);
            }}
            className="h-12 w-full rounded-lg border border-input bg-background pl-12 pr-4 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label="Sort products"
          >
            <option value="name_asc">Sort by product name</option>
            <option value="name_desc">Product name (Z–A)</option>
            <option value="newest">Latest status first</option>
          </select>
        </div>
      </div>

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
                  ? "inline-flex h-11 items-center gap-3 rounded-full bg-foreground px-5 text-sm font-medium text-background"
                  : "inline-flex h-11 items-center gap-3 rounded-full bg-muted/70 px-5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              {entry.label}
              <span
                className={
                  active
                    ? "rounded-full bg-background/15 px-2 py-0.5 text-xs"
                    : "rounded-full bg-background px-2 py-0.5 text-xs text-foreground"
                }
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <Card className="overflow-hidden p-0 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] border-collapse">
            <thead>
              <tr className="border-b bg-muted/10 text-left text-sm font-medium text-muted-foreground">
                <th className="w-16 px-6 py-4">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select visible products"
                    className="size-5 rounded border-border"
                  />
                </th>
                <th className="px-4 py-4">Product</th>
                <th className="px-4 py-4">Category</th>
                <th className="px-4 py-4">Status</th>
                <th className="px-3 py-4 text-center">Images found</th>
                <th className="px-3 py-4 text-center">Uploaded</th>
                <th className="px-3 py-4 text-center">Skipped</th>
                <th className="px-3 py-4 text-center">Failed</th>
                <th className="w-20 px-4 py-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length ? (
                visible.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b transition-colors last:border-b-0 hover:bg-muted/15"
                  >
                    <td className="px-6 py-4">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleOne(item.id)}
                        aria-label={`Select ${item.product_name}`}
                        className="size-5 rounded border-border"
                      />
                    </td>
                    <td className="px-4 py-4">
                      <div className="font-semibold">{item.product_name}</div>
                      {item.store_name ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {item.store_name}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-4">
                      <span className="inline-flex rounded-full bg-muted px-4 py-1.5 text-sm">
                        {item.category_name ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge item={item} />
                    </td>
                    <td className="px-3 py-4">
                      <CountCell value={item.images_found} />
                    </td>
                    <td className="px-3 py-4">
                      <CountCell value={item.images_uploaded} />
                    </td>
                    <td className="px-3 py-4">
                      <CountCell value={item.images_skipped} />
                    </td>
                    <td className="px-3 py-4">
                      <CountCell value={item.images_failed} />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            aria-label={`Actions for ${item.product_name}`}
                          >
                            <MoreVerticalIcon className="size-5" />
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
                  <td colSpan={9} className="px-6 py-20 text-center">
                    <div className="font-medium">No products found.</div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      Completed products and products needing attention will appear here.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">{footerText}</p>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            disabled={safePage <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            aria-label="Previous page"
          >
            <ChevronLeftIcon className="size-5" />
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
                className="size-11"
                onClick={() => setPage(number)}
              >
                {number}
              </Button>
            );
          })}

          <Button
            variant="outline"
            size="icon"
            className="size-11"
            disabled={safePage >= totalPages}
            onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
            aria-label="Next page"
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
