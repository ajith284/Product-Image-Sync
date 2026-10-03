import { PageHeader } from "@/components/shared/page-header";
import { ReviewProductsTable } from "@/components/review/review-products-table";
import { listReviewProducts } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Review" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const items = await listReviewProducts(ctx.workspace.workspaceId);

  return (
    <div className="w-full md:relative md:left-1/2 md:w-[calc(100vw-var(--sidebar-width)-2rem)] md:max-w-[1560px] md:-translate-x-1/2">
      <div className="grid gap-5">
        <PageHeader
          title="Review"
          description="Products from the latest sync state, including completed items and anything that needs attention."
        />
        <ReviewProductsTable items={items} />
      </div>
    </div>
  );
}
