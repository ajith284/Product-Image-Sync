import { FolderTreeIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Drive Mapping" };

export default async function Page() {
  await requireWorkspace();
  return (
    <>
      <PageHeader title="Drive Mapping" description="Google Drive folders that hold your product images." />
      <EmptyState icon={FolderTreeIcon} title="Google Drive integration will be added in a later phase." />
    </>
  );
}
