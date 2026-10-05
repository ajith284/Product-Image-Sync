"use client";

import {
  ActivityIcon,
  ArrowUpDownIcon,
  CircleCheckIcon,
  Clock3Icon,
  HardDriveIcon,
  Layers3Icon,
  ListChecksIcon,
  PlayIcon,
  SearchIcon,
  Settings2Icon,
  StoreIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type ActivityFeedItem = {
  id: string;
  store_id: string | null;
  store_name: string;
  event_type: string;
  message: string;
  metadata: unknown;
  created_at: string;
};

type EventCategory = "sync" | "store" | "drive" | "review" | "system";
type SortMode = "newest" | "oldest";
type DateRange = "7" | "30" | "90" | "all";

const EVENT_FILTERS: {
  key: EventCategory;
  label: string;
}[] = [
  { key: "sync", label: "Sync Job" },
  { key: "store", label: "Store" },
  { key: "drive", label: "Drive Mapping" },
  { key: "review", label: "Review" },
  { key: "system", label: "System" },
];

function eventCategory(eventType: string): EventCategory {
  if (eventType.startsWith("sync_job_")) return "sync";
  if (
    eventType.startsWith("shopify_") ||
    eventType.startsWith("store_")
  ) {
    return "store";
  }
  if (
    eventType.startsWith("google_drive_") ||
    eventType.includes("drive_mapping")
  ) {
    return "drive";
  }
  if (eventType.includes("review")) return "review";
  return "system";
}

function metadataValue(item: ActivityFeedItem, key: string): string | null {
  if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) {
    return null;
  }
  const value = (item.metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function jobState(item: ActivityFeedItem): "completed" | "started" | "queued" | "other" {
  if (item.event_type === "sync_job_queued") return "queued";
  if (item.event_type === "sync_job_started") return "started";
  if (item.event_type === "sync_job_finished") {
    const status = metadataValue(item, "status");
    if (status === "completed" || status === "completed_with_errors") return "completed";
  }
  return "other";
}

function eventTitle(item: ActivityFeedItem) {
  if (item.event_type === "sync_job_queued") return "Sync job queued";
  if (item.event_type === "sync_job_started") return "Sync job started";
  if (item.event_type === "sync_job_cancelled") return "Sync job cancelled";
  if (item.event_type === "sync_job_finished") {
    const status = metadataValue(item, "status");
    if (status === "completed") return "Sync job completed";
    if (status === "completed_with_errors") return "Sync job completed with errors";
    if (status === "failed") return "Sync job failed";
    if (status === "cancelled") return "Sync job cancelled";
    return "Sync job finished";
  }
  if (item.event_type === "shopify_connected") return "Shopify store connected";
  if (item.event_type === "shopify_reconnected") return "Shopify store reconnected";
  if (item.event_type === "shopify_disconnected") return "Shopify store disconnected";
  if (item.event_type === "shopify_uninstalled") return "Shopify app uninstalled";
  if (item.event_type === "shopify_verified") return "Shopify connection verified";
  if (item.event_type === "shopify_verification_failed") return "Shopify verification failed";
  if (item.event_type === "google_drive_connected") return "Google Drive connected";
  if (item.event_type === "google_drive_reconnected") return "Google Drive reconnected";
  if (item.event_type === "google_drive_disconnected") return "Google Drive disconnected";
  if (item.event_type === "google_drive_verified") return "Google Drive connection verified";
  if (item.event_type === "google_drive_verification_failed") return "Google Drive verification failed";
  if (item.event_type === "api_key_created") return "API key created";
  if (item.event_type === "api_key_revoked") return "API key revoked";

  return item.event_type
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function eventStyle(item: ActivityFeedItem) {
  if (item.event_type === "sync_job_queued") {
    return {
      label: "Queued",
      badge: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
      iconWrap: "bg-amber-50 text-amber-600 dark:bg-amber-950/70 dark:text-amber-300",
      Icon: ListChecksIcon,
    };
  }
  if (item.event_type === "sync_job_started") {
    return {
      label: "Started",
      badge: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      iconWrap: "bg-blue-50 text-blue-600 dark:bg-blue-950/70 dark:text-blue-300",
      Icon: PlayIcon,
    };
  }
  if (item.event_type === "sync_job_finished") {
    const status = metadataValue(item, "status");
    if (status === "failed") {
      return {
        label: "Failed",
        badge: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
        iconWrap: "bg-red-50 text-red-600 dark:bg-red-950/70 dark:text-red-300",
        Icon: ActivityIcon,
      };
    }
    if (status === "cancelled") {
      return {
        label: "Cancelled",
        badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
        iconWrap: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
        Icon: ActivityIcon,
      };
    }
    return {
      label: status === "completed_with_errors" ? "Completed with errors" : "Completed",
      badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
      iconWrap: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/70 dark:text-emerald-300",
      Icon: CircleCheckIcon,
    };
  }

  const category = eventCategory(item.event_type);
  if (item.event_type.includes("failed")) {
    return {
      label: "Failed",
      badge: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
      iconWrap: "bg-red-50 text-red-600 dark:bg-red-950/70 dark:text-red-300",
      Icon: ActivityIcon,
    };
  }
  if (category === "store") {
    return {
      label: item.event_type.includes("disconnected") || item.event_type.includes("uninstalled")
        ? "Disconnected"
        : "Connected",
      badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
      iconWrap: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
      Icon: StoreIcon,
    };
  }
  if (category === "drive") {
    return {
      label: item.event_type.includes("disconnected") ? "Disconnected" : "Drive",
      badge: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
      iconWrap: "bg-violet-50 text-violet-600 dark:bg-violet-950/70 dark:text-violet-300",
      Icon: HardDriveIcon,
    };
  }
  if (category === "review") {
    return {
      label: "Review",
      badge: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
      iconWrap: "bg-orange-50 text-orange-600 dark:bg-orange-950/70 dark:text-orange-300",
      Icon: ListChecksIcon,
    };
  }
  return {
    label: "System",
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    iconWrap: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    Icon: Settings2Icon,
  };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function percentage(value: number, total: number) {
  if (!total) return "0%";
  const amount = (value / total) * 100;
  return `${amount.toFixed(amount % 1 === 0 ? 0 : 1)}%`;
}

function SummaryCard({
  label,
  value,
  helper,
  icon,
  iconClass,
}: {
  label: string;
  value: number;
  helper: string;
  icon: React.ReactNode;
  iconClass: string;
}) {
  return (
    <Card className="min-h-[112px] p-4 shadow-none">
      <div className="flex items-start gap-4">
        <div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${iconClass}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
          <p className="mt-1 text-sm text-muted-foreground">{helper}</p>
        </div>
      </div>
    </Card>
  );
}

export function ActivityFeed({ items }: { items: ActivityFeedItem[] }) {
  const [search, setSearch] = useState("");
  const [storeId, setStoreId] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>("30");
  const [sort, setSort] = useState<SortMode>("newest");
  const [categories, setCategories] = useState<Set<EventCategory>>(new Set());

  const stores = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.store_id) map.set(item.store_id, item.store_name);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const baseFiltered = useMemo(() => {
    const now = Date.now();
    const days = dateRange === "all" ? null : Number(dateRange);
    const cutoff = days ? now - days * 24 * 60 * 60 * 1000 : null;

    return items.filter((item) => {
      if (storeId !== "all" && item.store_id !== storeId) return false;
      if (cutoff !== null && new Date(item.created_at).getTime() < cutoff) return false;
      return true;
    });
  }, [dateRange, items, storeId]);

  const stats = useMemo(() => {
    const latestByJob = new Map<string, ActivityFeedItem>();

    for (const item of baseFiltered) {
      if (!item.event_type.startsWith("sync_job_")) continue;
      const jobId = metadataValue(item, "job_id");
      if (!jobId) continue;

      const previous = latestByJob.get(jobId);
      if (!previous || new Date(item.created_at).getTime() > new Date(previous.created_at).getTime()) {
        latestByJob.set(jobId, item);
      }
    }

    let completed = 0;
    let started = 0;
    let queued = 0;

    for (const item of latestByJob.values()) {
      const state = jobState(item);
      if (state === "completed") completed += 1;
      if (state === "started") started += 1;
      if (state === "queued") queued += 1;
    }

    const total = latestByJob.size;
    return { total, completed, started, queued };
  }, [baseFiltered]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    return baseFiltered
      .filter((item) => categories.size === 0 || categories.has(eventCategory(item.event_type)))
      .filter((item) => {
        if (!q) return true;
        const searchable = [
          item.store_name,
          eventTitle(item),
          item.message,
          item.event_type.replaceAll("_", " "),
          JSON.stringify(item.metadata ?? {}),
        ]
          .join(" ")
          .toLowerCase();
        return searchable.includes(q);
      })
      .sort((a, b) => {
        const difference = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        return sort === "newest" ? difference : -difference;
      });
  }, [baseFiltered, categories, search, sort]);

  const toggleCategory = (key: EventCategory) => {
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearFilters = () => {
    setSearch("");
    setStoreId("all");
    setDateRange("30");
    setSort("newest");
    setCategories(new Set());
  };

  return (
    <div className="grid gap-5">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Activity</h1>
        <p className="text-muted-foreground">
          A readable history of store connections, sync jobs, and other workspace events.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Total Jobs"
          value={stats.total}
          helper="All sync jobs"
          icon={<Layers3Icon className="size-5" />}
          iconClass="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100"
        />
        <SummaryCard
          label="Completed"
          value={stats.completed}
          helper={`${percentage(stats.completed, stats.total)} of jobs`}
          icon={<CircleCheckIcon className="size-5" />}
          iconClass="bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
        />
        <SummaryCard
          label="Started"
          value={stats.started}
          helper={`${percentage(stats.started, stats.total)} of jobs`}
          icon={<PlayIcon className="size-5" />}
          iconClass="bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300"
        />
        <SummaryCard
          label="Queued"
          value={stats.queued}
          helper={`${percentage(stats.queued, stats.total)} of jobs`}
          icon={<Clock3Icon className="size-5" />}
          iconClass="bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-300"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card className="h-fit p-4 shadow-none">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Filters</h2>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear all
            </Button>
          </div>

          <div className="mt-5 space-y-6">
            <div>
              <p className="mb-3 text-sm font-semibold">Event Type</p>
              <label className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={categories.size === 0}
                  onChange={() => setCategories(new Set())}
                  className="size-4 rounded border-border accent-foreground"
                />
                <span>All Events</span>
              </label>
              {EVENT_FILTERS.map((filter) => (
                <label
                  key={filter.key}
                  className="flex cursor-pointer items-center gap-2.5 py-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={categories.has(filter.key)}
                    onChange={() => toggleCategory(filter.key)}
                    className="size-4 rounded border-border accent-foreground"
                  />
                  <span>{filter.label}</span>
                </label>
              ))}
            </div>

            <div>
              <label htmlFor="activity-store" className="mb-2 block text-sm font-semibold">
                Store
              </label>
              <select
                id="activity-store"
                value={storeId}
                onChange={(event) => setStoreId(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="all">All Stores</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="activity-range" className="mb-2 block text-sm font-semibold">
                Date Range
              </label>
              <div className="relative">
                <Clock3Icon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <select
                  id="activity-range"
                  value={dateRange}
                  onChange={(event) => setDateRange(event.target.value as DateRange)}
                  className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="all">All time</option>
                </select>
              </div>
            </div>
          </div>
        </Card>

        <Card className="overflow-hidden p-0 shadow-none">
          <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by store, product, or event..."
                className="h-10 pl-9"
              />
            </div>

            <div className="relative w-full lg:w-44">
              <ArrowUpDownIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Sort activity"
              >
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center">
              <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-muted">
                <ActivityIcon className="size-5 text-muted-foreground" />
              </div>
              <p className="font-semibold">No activity matches these filters.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Change the event type, store, date range, or search term.
              </p>
            </div>
          ) : (
            <div className="divide-y px-4">
              {filtered.map((item) => {
                const style = eventStyle(item);
                const Icon = style.Icon;

                return (
                  <div
                    key={item.id}
                    className="grid gap-3 py-3.5 sm:grid-cols-[52px_minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className={`flex size-11 items-center justify-center rounded-xl ${style.iconWrap}`}>
                      <Icon className="size-5" />
                    </div>

                    <div className="min-w-0">
                      <p className="font-semibold leading-5">{eventTitle(item)}</p>
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">
                        {item.store_name} · {formatDateTime(item.created_at)}
                      </p>
                      <p className="mt-0.5 break-words text-sm text-muted-foreground">
                        {item.message}
                      </p>
                    </div>

                    <div className="pl-[56px] sm:pl-0">
                      <span
                        className={`inline-flex whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold ${style.badge}`}
                      >
                        {style.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
