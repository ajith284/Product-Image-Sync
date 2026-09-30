import { PlusIcon, StoreIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { StoreTable } from "@/components/stores/store-table";
import { Button } from "@/components/ui/button";
import { listStores } from "@/lib/data/stores";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Stores" };

export default async function StoresPage() {
  const ctx = await requireWorkspace();
  const stores = await listStores(ctx.workspace.workspaceId);
  const canAdd = hasPermission(ctx, "manageStores");

  const addButton = canAdd ? (
    <Button asChild>
      <Link href="/stores/new">
        <PlusIcon />
        Add Store
      </Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Stores"
        description="Shopify stores in this workspace."
        actions={stores.length > 0 ? addButton : null}
      />
      {stores.length === 0 ? (
        <EmptyState
          icon={StoreIcon}
          title="No stores connected."
          description={canAdd ? "Add your first Shopify store." : "Ask a workspace owner or admin to add a store."}
          action={addButton}
        />
      ) : (
        <StoreTable stores={stores} />
      )}
    </>
  );
}
