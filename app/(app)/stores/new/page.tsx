import { LockIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { AddStoreWizard } from "@/components/stores/add-store-wizard";
import { Button } from "@/components/ui/button";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Add store" };

export default async function AddStorePage() {
  const ctx = await requireWorkspace();

  if (!hasPermission(ctx, "manageStores")) {
    return (
      <>
        <PageHeader title="Add store" />
        <EmptyState
          icon={LockIcon}
          title="You can't add stores in this workspace."
          description="Only workspace owners and admins can add stores. Ask one of them to add it for you."
          action={
            <Button variant="outline" asChild>
              <Link href="/stores">Back to stores</Link>
            </Button>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Add store"
        description={`Set up a Shopify store in ${ctx.workspace.workspaceName}.`}
      />
      <AddStoreWizard />
    </>
  );
}
