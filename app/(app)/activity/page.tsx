import { ActivityIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Activity" };

export default async function Page() {
  await requireWorkspace();
  return (
    <>
      <PageHeader title="Activity" description="A readable history of everything that happened." />
      <EmptyState icon={ActivityIcon} title="No activity yet." />
    </>
  );
}
