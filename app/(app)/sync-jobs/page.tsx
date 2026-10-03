import { AlertCircleIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PageAutoRefresh } from "@/components/sync/page-auto-refresh";
import { SyncStatusBadge } from "@/components/sync/sync-status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listSyncJobs } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Sync Jobs" };

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default async function Page() {
  const ctx = await requireWorkspace();
  const jobs = await listSyncJobs(ctx.workspace.workspaceId);
  const hasActive = jobs.some((job) => job.status === "queued" || job.status === "running");

  return (
    <>
      <PageAutoRefresh enabled={hasActive} />
      <PageHeader title="Sync Jobs" description="Every image sync, its live status, and final counts." />

      {jobs.length === 0 ? (
        <EmptyState
          icon={RefreshCwIcon}
          title="No sync jobs yet."
          description="Open a store, connect one category folder, and press Start Sync."
          action={
            <Button variant="outline" asChild>
              <Link href="/stores">Open Stores</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardHeader className="border-b">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <CardTitle className="text-base">{job.store_name}</CardTitle>
                    <p className="text-xs text-muted-foreground">Started {formatDateTime(job.started_at ?? job.created_at)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {job.dry_run ? <Badge variant="outline">Dry run</Badge> : null}
                    <SyncStatusBadge status={job.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Metric label="Processed" value={job.products_processed} />
                  <Metric label="Synced" value={job.products_synced} />
                  <Metric label="Uploaded" value={job.images_uploaded} />
                  <Metric label="Skipped" value={job.items_skipped} />
                  <Metric label="Review" value={job.items_review} />
                  <Metric label="Failed" value={job.items_failed} />
                </div>

                {job.error_message ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertDescription>{job.error_message}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Job {job.id}</span>
                  <span>{job.completed_at ? `Finished ${formatDateTime(job.completed_at)}` : job.status === "queued" || job.status === "running" ? "Updates automatically" : ""}</span>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/stores/${job.store_id}`}>Open Store</Link>
                  </Button>
                  {(job.items_review > 0 || job.items_failed > 0) && !job.dry_run ? (
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/review">Review Issues</Link>
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
