"use client";

import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, PlayIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { startStoreSync } from "@/app/(app)/stores/[id]/sync-actions";
import { SyncStatusBadge } from "@/components/sync/sync-status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export type SyncJobSnapshot = {
  jobId: string;
  status: string;
  progress: {
    total: number;
    processed: number;
    synced: number;
    uploaded: number;
    skipped: number;
    review: number;
    failed: number;
    warnings?: number;
    errors?: number;
  };
  error?: { code: string | null; message: string } | null;
};

type Props = {
  storeId: string;
  canManage: boolean;
  shopifyConnected: boolean;
  driveConnected: boolean;
  categories: { id: string; name: string }[];
  initialJob: SyncJobSnapshot | null;
};

const ACTIVE = new Set(["queued", "running"]);
const TERMINAL = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function SyncControl({ storeId, canManage, shopifyConnected, driveConnected, categories, initialJob }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [job, setJob] = useState<SyncJobSnapshot | null>(initialJob);
  const [error, setError] = useState<string | null>(null);
  const active = Boolean(job && ACTIVE.has(job.status));
  const category = categories.length === 1 ? categories[0] : null;

  useEffect(() => {
    if (!job || !ACTIVE.has(job.status)) return;
    let stopped = false;

    const poll = async () => {
      try {
        const response = await fetch(`/api/sync-jobs/${job.jobId}`, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as SyncJobSnapshot | { error?: string } | null;
        if (stopped) return;
        if (!response.ok || !body || !("jobId" in body)) {
          setError(body && "error" in body ? body.error ?? "We couldn't refresh sync progress." : "We couldn't refresh sync progress.");
          return;
        }
        setError(null);
        setJob(body);
        if (TERMINAL.has(body.status)) router.refresh();
      } catch {
        if (!stopped) setError("We couldn't refresh sync progress. We'll try again automatically.");
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [job?.jobId, job?.status, router]);

  const readinessMessage = useMemo(() => {
    if (!shopifyConnected) return "Connect Shopify before starting a sync.";
    if (!driveConnected) return "Connect Google Drive before starting a sync.";
    if (categories.length === 0) return "Select one category folder before starting a sync.";
    if (categories.length > 1) return "Keep only one category folder connected for each sync.";
    return null;
  }, [categories.length, driveConnected, shopifyConnected]);

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await startStoreSync(storeId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setJob({
        jobId: result.jobId,
        status: result.status === "queued" ? "queued" : "running",
        progress: { total: 0, processed: 0, synced: 0, uploaded: 0, skipped: 0, review: 0, failed: 0 },
        error: null,
      });
    });
  };

  const total = job?.progress.total ?? 0;
  const processed = job?.progress.processed ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const terminal = Boolean(job && TERMINAL.has(job.status));

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle className="flex items-center gap-2">
              <RefreshCwIcon className="size-4" /> Product Image Sync
            </CardTitle>
            <CardDescription>
              {category ? `Connected category: ${category.name}` : "Connect one category folder, then start the sync here."}
            </CardDescription>
          </div>
          {job ? <SyncStatusBadge status={job.status} /> : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {readinessMessage ? (
          <Alert>
            <AlertCircleIcon />
            <AlertDescription>{readinessMessage}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {job ? (
          <div className="grid gap-4" aria-live="polite">
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">
                  {ACTIVE.has(job.status) ? "Processing" : job.status === "completed" ? "Sync finished" : "Sync result"}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {processed}/{total || "—"} products {total > 0 ? `· ${percent}%` : ""}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="Processed" value={processed} />
              <Metric label="Synced" value={job.progress.synced} />
              <Metric label="Uploaded" value={job.progress.uploaded} />
              <Metric label="Skipped" value={job.progress.skipped} />
              <Metric label="Review" value={job.progress.review} />
              <Metric label="Failed" value={job.progress.failed} />
            </div>

            {job.error?.message ? (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{job.error.message}</AlertDescription>
              </Alert>
            ) : terminal && job.status === "completed" ? (
              <Alert>
                <CheckCircle2Icon />
                <AlertDescription>Sync completed. You can remove this category folder and connect the next category.</AlertDescription>
              </Alert>
            ) : terminal && (job.progress.review > 0 || job.progress.failed > 0) ? (
              <Alert>
                <AlertCircleIcon />
                <AlertDescription>
                  Sync finished with items that need attention. Open Review to see the affected products.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <Link href="/sync-jobs">View Sync Jobs</Link>
              </Button>
              {(job.progress.review > 0 || job.progress.failed > 0) && terminal ? (
                <Button variant="outline" asChild>
                  <Link href="/review">Review Issues</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {canManage ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={start} disabled={pending || active || Boolean(readinessMessage)}>
              {pending || active ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
              {pending ? "Starting…" : active ? "Sync in progress" : "Start Sync"}
            </Button>
            {active ? <span className="text-sm text-muted-foreground">Progress updates automatically.</span> : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only workspace owners and admins can start a sync.</p>
        )}
      </CardContent>
    </Card>
  );
}
