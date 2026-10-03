import { InboxIcon } from "lucide-react";
import Link from "next/link";

import { ReviewProductsTable } from "@/components/review/review-products-table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { listProductReviewItems } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Review" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const items = await listProductReviewItems(ctx.workspace.workspaceId);

  return (
    <div className="w-full md:relative md:left-1/2 md:w-[calc(100vw-var(--sidebar-width)-2rem)] md:max-w-[1560px] md:-translate-x-1/2">
      <div className="grid gap-5">
        <PageHeader
          title="Review"
          description="Review every synced product, its latest status, and image counts."
        />

        {items.length === 0 ? (
          <EmptyState
            icon={InboxIcon}
            title="No synced products yet."
            description="Products will appear here after a sync runs."
            action={
              <Button variant="outline" asChild>
                <Link href="/stores">Open Stores</Link>
              </Button>
            }
          />
        ) : (
          <ReviewProductsTable items={items} />
        )}
      </div>
    </div>
  );
}
