import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PageAutoRefresh } from "@/components/sync/page-auto-refresh";
import { SyncJobsOverview } from "@/components/sync/sync-jobs-overview";
import { Button } from "@/components/ui/button";
import { listSyncStoreOverview } from "@/lib/data/sync";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Sync Jobs" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const stores = await listSyncStoreOverview(ctx.workspace.workspaceId);
  const hasActive = stores.some((store) => store.sync_status === "in_progress");

  return (
    <div className="w-full md:relative md:left-1/2 md:w-[calc(100vw-var(--sidebar-width)-2rem)] md:max-w-[1560px] md:-translate-x-1/2">
      <PageAutoRefresh enabled={hasActive} />
      <div className="grid gap-5">
      <PageHeader
        title="Sync Jobs"
        description="Every store's latest image sync, live status, and final counts."
      />

      {stores.length === 0 ? (
        <EmptyState
          icon={RefreshCwIcon}
          title="No stores yet."
          description="Add a Shopify store, connect one category folder, and press Start Sync."
          action={
            hasPermission(ctx, "manageStores") ? (
              <Button variant="outline" asChild>
                <Link href="/stores/new">Add Store</Link>
              </Button>
            ) : (
              <Button variant="outline" asChild>
                <Link href="/stores">Open Stores</Link>
              </Button>
            )
          }
        />
      ) : (
        <SyncJobsOverview
          stores={stores}
          canManageStores={hasPermission(ctx, "manageStores")}
        />
      )}
      </div>
    </div>
  );
}
