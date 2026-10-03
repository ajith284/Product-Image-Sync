import { Badge } from "@/components/ui/badge";

const LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Processing",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function SyncStatusBadge({ status }: { status: string }) {
  const variant =
    status === "failed" || status === "cancelled"
      ? "destructive"
      : status === "completed"
        ? "default"
        : status === "completed_with_errors" || status === "running" || status === "queued"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{LABELS[status] ?? status}</Badge>;
}
