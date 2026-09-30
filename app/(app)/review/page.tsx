import { InboxIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Review" };

export default async function Page() {
  await requireWorkspace();
  return (
    <>
      <PageHeader title="Review" description="Products that need your attention before images can upload." />
      <EmptyState icon={InboxIcon} title="No items require review." />
    </>
  );
}
