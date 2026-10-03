import { PageHeader } from "@/components/shared/page-header";
import { ReviewProductsOverview } from "@/components/review/review-products-overview";
import { listProductReviewOverview } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Review" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const items = await listProductReviewOverview(ctx.workspace.workspaceId);

  return (
    <div className="w-full md:relative md:left-1/2 md:w-[calc(100vw-var(--sidebar-width)-2rem)] md:max-w-[1560px] md:-translate-x-1/2">
      <div className="grid gap-5">
        <PageHeader
          title="Review"
          description="Complete product status from the latest sync result for every product folder."
        />
        <ReviewProductsOverview items={items} />
      </div>
    </div>
  );
}
