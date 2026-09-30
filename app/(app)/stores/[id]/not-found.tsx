import { StoreIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function StoreNotFound() {
  return (
    <EmptyState
      icon={StoreIcon}
      title="Store not found"
      description="This store doesn't exist in your current workspace, or you don't have access to it."
      action={
        <Button variant="outline" asChild>
          <Link href="/stores">Back to stores</Link>
        </Button>
      }
    />
  );
}
