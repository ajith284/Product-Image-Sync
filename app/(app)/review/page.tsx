import { ReviewTable } from "@/components/review/review-table";
import { listReviewItems } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Review" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const items = await listReviewItems(ctx.workspace.workspaceId);

  return (
    <div className="w-full md:relative md:left-1/2 md:w-[calc(100vw-var(--sidebar-width)-2rem)] md:max-w-[1560px] md:-translate-x-1/2">
      <ReviewTable items={items} />
    </div>
  );
}
