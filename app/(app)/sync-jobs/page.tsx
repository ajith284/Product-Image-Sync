import { RefreshCwIcon } from "lucide-react";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Sync Jobs" };

export default function Page() {
  return (
    <>
      <PageHeader title="Sync Jobs" description="See every image sync and what it uploaded." />
      <ComingSoon icon={RefreshCwIcon} text="Each sync will be listed here with the products it matched, images uploaded and anything skipped." />
    </>
  );
}
