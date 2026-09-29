import { InboxIcon } from "lucide-react";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Review Center" };

export default function Page() {
  return (
    <>
      <PageHeader title="Review Center" description="Resolve products that need your attention before images can upload." />
      <ComingSoon icon={InboxIcon} text="Folders with no matching product, more than one matching product, or failed uploads will appear here for you to resolve." />
    </>
  );
}
