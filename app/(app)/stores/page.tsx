import { PlusIcon, StoreIcon } from "lucide-react";
import Link from "next/link";

import { ComingSoon } from "@/components/shared/coming-soon";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Stores" };

export default function StoresPage() {
  return (
    <>
      <PageHeader
        title="Stores"
        description="Connect and manage your Shopify stores."
        actions={
          <Button asChild>
            <Link href="/stores/new">
              <PlusIcon />
              Add store
            </Link>
          </Button>
        }
      />
      <ComingSoon
        icon={StoreIcon}
        text="Your connected Shopify stores will be listed here, each with its own Google Drive folder and sync settings."
      />
    </>
  );
}
