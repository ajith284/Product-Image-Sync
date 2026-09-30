import { RefreshCwIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Sync Jobs" };

export default async function Page() {
  await requireWorkspace();
  return (
    <>
      <PageHeader title="Sync Jobs" description="Every image sync and what it uploaded." />
      <EmptyState icon={RefreshCwIcon} title="No sync jobs yet." />
    </>
  );
}
