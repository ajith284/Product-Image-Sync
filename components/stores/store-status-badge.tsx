import { Badge } from "@/components/ui/badge";
import type { StoreStatus } from "@/lib/supabase/constants";
import { cn } from "@/lib/utils";

const LABELS: Record<StoreStatus, string> = {
  setup: "Setup",
  connected: "Connected",
  disconnected: "Disconnected",
  needs_reconnect: "Needs reconnect",
  error: "Error",
};

const DOT: Record<StoreStatus, string> = {
  setup: "bg-muted-foreground",
  connected: "bg-emerald-500",
  disconnected: "bg-muted-foreground",
  needs_reconnect: "bg-amber-500",
  error: "bg-destructive",
};

export function StoreStatusBadge({ status }: { status: string }) {
  const s = (status in LABELS ? status : "setup") as StoreStatus;
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-1.5 rounded-full", DOT[s])} aria-hidden />
      {LABELS[s]}
    </Badge>
  );
}
