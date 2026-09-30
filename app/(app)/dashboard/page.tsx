import { ImageIcon, InboxIcon, PackageCheckIcon, PlusIcon, StoreIcon } from "lucide-react";
import Link from "next/link";

import { StatCard } from "@/components/dashboard/stat-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { StoreCard } from "@/components/stores/store-card";
import { Button } from "@/components/ui/button";
import { getDashboardStats } from "@/lib/data/stores";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireWorkspace();
  const stats = await getDashboardStats(ctx.workspace.workspaceId);
  const canAdd = hasPermission(ctx, "manageStores");
  const firstName = ctx.user.fullName?.split(" ")[0];

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome, ${firstName}` : "Dashboard"}
        description={`Overview of ${ctx.workspace.workspaceName}.`}
        actions={
          canAdd && stats.stores.length > 0 ? (
            <Button asChild>
              <Link href="/stores/new">
                <PlusIcon />
                Add store
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Connected Stores" value={stats.connectedStores} icon={StoreIcon} hint={`${stats.stores.length} total`} />
        <StatCard label="Products Synced" value={stats.productsSynced} icon={PackageCheckIcon} />
        <StatCard label="Images Uploaded" value={stats.imagesUploaded} icon={ImageIcon} />
        <StatCard label="Needs Review" value={stats.needsReview} icon={InboxIcon} />
      </div>

      {stats.stores.length === 0 ? (
        <EmptyState
          icon={StoreIcon}
          title="No Shopify stores connected yet."
          description={
            canAdd
              ? "Connect your first store to begin."
              : "Ask a workspace owner or admin to add your first store."
          }
          action={
            canAdd ? (
              <Button asChild>
                <Link href="/stores/new">
                  <PlusIcon />
                  Add Store
                </Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <section className="grid gap-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Your stores</h2>
            <Button variant="link" asChild className="h-auto p-0">
              <Link href="/stores">View all</Link>
            </Button>
          </div>
          {stats.stores.slice(0, 5).map((store) => (
            <StoreCard key={store.id} store={store} />
          ))}
        </section>
      )}
    </>
  );
}
