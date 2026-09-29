import { StoreIcon } from "lucide-react";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Add Store" };

export default function Page() {
  return (
    <>
      <PageHeader title="Add Store" description="Connect a Shopify store to start syncing images." />
      <ComingSoon icon={StoreIcon} text="Connecting a Shopify store will be available here soon. You'll approve access in Shopify — no passwords or API keys to copy." />
    </>
  );
}
