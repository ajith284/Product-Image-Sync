"use client";

import {
  ArrowUpIcon,
  CalendarDaysIcon,
  CheckCircle2Icon,
  EyeIcon,
  Layers3Icon,
  MoreVerticalIcon,
  SearchIcon,
  SkipForwardIcon,
  StoreIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { removeStoreFromWorkspace } from "@/app/(app)/sync-jobs/actions";
import type {
  SyncStoreOverviewItem,
  SyncStoreOverviewStatus,
} from "@/lib/data/sync";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

type Filter = "all" | SyncStoreOverviewStatus;
type Sort = "newest" | "oldest" | "name";

const STATUS_META: Record<
  SyncStoreOverviewStatus,
  { label: string; className: string }
> = {
  completed: {
    label: "Completed",
    className: "bg-foreground text-background",
  },
  in_progress: {
    label: "In Progress",
    className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  },
  skipped: {
    label: "Skipped",
    className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  review: {
    label: "Review",
    className: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  },
  failed: {
    label: "Failed",
    className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All Stores" },
  { key: "completed", label: "Completed" },
  { key: "in_progress", label: "In Progress" },
  { key: "skipped", label: "Skipped" },
  { key: "review", label: "Review" },
  { key: "failed", label: "Failed" },
];

function toTimestamp(item: SyncStoreOverviewItem) {
  const value = item.started_at ?? item.created_at;
  return value ? new Date(value).getTime() : 0;
}

function formatStarted(item: SyncStoreOverviewItem) {
  const value = item.started_at ?? item.created_at;
  if (!value) return "No sync yet";
  return `Started ${new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))}`;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/45 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  icon,
  iconClassName,
}: {
  label: string;
  value: number;
  detail: string;
  icon: React.ReactNode;
  iconClassName: string;
}) {
  return (
    <Card className="flex min-w-0 flex-row items-center gap-3 p-4 shadow-sm">
      <div className={`flex size-11 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        <div className="whitespace-nowrap text-xs text-muted-foreground">{detail}</div>
      </div>
    </Card>
  );
}

export function SyncJobsOverview({
  stores,
  canManageStores,
}: {
  stores: SyncStoreOverviewItem[];
  canManageStores: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [removeTarget, setRemoveTarget] =
    useState<SyncStoreOverviewItem | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const counts = useMemo(() => {
    const result: Record<SyncStoreOverviewStatus, number> = {
      completed: 0,
      in_progress: 0,
      skipped: 0,
      review: 0,
      failed: 0,
    };
    for (const store of stores) result[store.sync_status] += 1;
    return result;
  }, [stores]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stores
      .filter(
        (store) =>
          (filter === "all" || store.sync_status === filter) &&
          (!q ||
            store.store_name.toLowerCase().includes(q) ||
            store.shopify_domain?.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        if (sort === "name") return a.store_name.localeCompare(b.store_name);
        const delta = toTimestamp(b) - toTimestamp(a);
        return sort === "newest" ? delta : -delta;
      });
  }, [filter, search, sort, stores]);

  const connected = stores.filter((store) => store.store_status === "connected").length;
  const pct = (value: number) =>
    stores.length ? `${((value / stores.length) * 100).toFixed(value === stores.length ? 0 : 1)}% stores` : "0% stores";

  const openRemove = (store: SyncStoreOverviewItem) => {
    setRemoveError(null);
    setRemoveTarget(store);
  };

  const removeStore = () => {
    if (!removeTarget) return;
    const id = removeTarget.store_id;
    setRemoveError(null);
    startTransition(async () => {
      const result = await removeStoreFromWorkspace(id);
      if (!result.ok) {
        setRemoveError(result.error);
        return;
      }
      setRemoveTarget(null);
      router.refresh();
    });
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryCard
          label="Total Stores"
          value={stores.length}
          detail={`${connected} connected ${connected === 1 ? "store" : "stores"}`}
          icon={<Layers3Icon className="size-5" />}
          iconClassName="bg-muted text-foreground"
        />
        <SummaryCard
          label="Completed"
          value={counts.completed}
          detail={pct(counts.completed)}
          icon={<CheckCircle2Icon className="size-5" />}
          iconClassName="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
        />
        <SummaryCard
          label="In Progress"
          value={counts.in_progress}
          detail={pct(counts.in_progress)}
          icon={<ArrowUpIcon className="size-5" />}
          iconClassName="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
        />
        <SummaryCard
          label="Skipped"
          value={counts.skipped}
          detail={pct(counts.skipped)}
          icon={<SkipForwardIcon className="size-5" />}
          iconClassName="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
        />
        <SummaryCard
          label="Review"
          value={counts.review}
          detail={pct(counts.review)}
          icon={<EyeIcon className="size-5" />}
          iconClassName="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
        />
        <SummaryCard
          label="Failed"
          value={counts.failed}
          detail={pct(counts.failed)}
          icon={<XIcon className="size-5" />}
          iconClassName="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
        />
      </div>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-2 xl:flex-nowrap">
          {FILTERS.map((item) => {
            const count = item.key === "all" ? stores.length : counts[item.key];
            const active = filter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
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

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 sm:w-80">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search stores..."
              className="pl-9"
            />
          </div>
          <div className="relative sm:w-56">
            <CalendarDaysIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
              className="h-9 w-full appearance-none rounded-md border border-input bg-transparent pl-9 pr-8 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              aria-label="Sort stores"
            >
              <option value="newest">Last Sync (Newest)</option>
              <option value="oldest">Last Sync (Oldest)</option>
              <option value="name">Store Name (A–Z)</option>
            </select>
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="font-medium">No stores match this view.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try another status filter or search term.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {visible.map((store) => {
            const status = STATUS_META[store.sync_status];
            const active = store.sync_status === "in_progress";
            return (
              <Card key={store.store_id} className="p-4 shadow-sm">
                <div className="grid gap-3">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <StoreIcon className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/stores/${store.store_id}`}
                        className="truncate font-semibold hover:underline"
                      >
                        {store.store_name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {formatStarted(store)}
                        {store.dry_run ? " · Dry run" : ""}
                      </p>
                    </div>
                    <span
                      className={`inline-flex h-7 shrink-0 items-center rounded-full px-4 text-xs font-semibold ${status.className}`}
                    >
                      {status.label}
                    </span>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label={`Actions for ${store.store_name}`}
                        >
                          <MoreVerticalIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/stores/${store.store_id}`}>
                            <StoreIcon />
                            Open store
                          </Link>
                        </DropdownMenuItem>
                        {canManageStores ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={active}
                              variant="destructive"
                              onSelect={() => openRemove(store)}
                            >
                              <Trash2Icon />
                              Remove store
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Metric label="Processed" value={store.products_processed} />
                    <Metric label="Synced" value={store.products_synced} />
                    <Metric label="Uploaded" value={store.images_uploaded} />
                    <Metric label="Skipped" value={store.items_skipped} />
                    <Metric label="Review" value={store.items_review} />
                    <Metric label="Failed" value={store.items_failed} />
                  </div>

                  {store.error_message ? (
                    <p className="text-xs text-destructive">{store.error_message}</p>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setRemoveTarget(null);
            setRemoveError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removeTarget?.store_name ?? "store"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the store from Product Image Sync, including its
              connection records, Drive mapping, mappings, and sync history.
              It does not delete Shopify products or images, and it does not
              delete files from Google Drive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? (
            <p className="text-sm text-destructive">{removeError}</p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={removeStore}
            >
              {pending ? "Removing..." : "Remove store"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
