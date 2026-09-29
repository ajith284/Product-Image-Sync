import { ActivityIcon } from "lucide-react";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Activity" };

export default function Page() {
  return (
    <>
      <PageHeader title="Activity" description="A readable history of everything that happened." />
      <ComingSoon icon={ActivityIcon} text="A plain-language log of syncs, matches and uploads will appear here." />
    </>
  );
}
