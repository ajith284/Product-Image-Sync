import { FolderTreeIcon } from "lucide-react";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Drive Mapping" };

export default function Page() {
  return (
    <>
      <PageHeader title="Drive Mapping" description="Choose the Google Drive folders that hold your product images." />
      <ComingSoon icon={FolderTreeIcon} text="Once a store is connected, you'll pick a Google Drive root folder here and see which product folders were found." />
    </>
  );
}
