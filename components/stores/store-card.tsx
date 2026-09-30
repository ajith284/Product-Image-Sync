import { ChevronRightIcon, StoreIcon } from "lucide-react";
import Link from "next/link";

import { StoreStatusBadge } from "@/components/stores/store-status-badge";
import { formatDate, type StoreListItem } from "@/components/stores/types";
import { Card } from "@/components/ui/card";

/** Compact store row used on small screens and the dashboard. */
export function StoreCard({ store }: { store: StoreListItem }) {
  return (
    <Card className="p-0 transition-colors hover:bg-muted/50">
      <Link href={`/stores/${store.id}`} className="flex items-center gap-3 p-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <StoreIcon className="size-4 text-muted-foreground" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate font-medium">{store.name}</span>
          <span className="truncate text-sm text-muted-foreground">
            {store.shopify_domain ?? "No domain yet"}
            <span className="hidden sm:inline"> · Added {formatDate(store.created_at)}</span>
          </span>
        </span>
        <StoreStatusBadge status={store.status} />
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </Card>
  );
}
