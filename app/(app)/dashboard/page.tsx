import { ImageIcon, InboxIcon, StoreIcon } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Dashboard" };

const stats = [
  { label: "Connected stores", icon: StoreIcon },
  { label: "Images uploaded", icon: ImageIcon },
  { label: "Needs review", icon: InboxIcon },
];

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={user.email ? `Signed in as ${user.email}` : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardDescription>{s.label}</CardDescription>
              <s.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">0</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Get started</CardTitle>
          <CardDescription>
            Connect a Shopify store, then choose the Google Drive folder with your product
            images. We&apos;ll match each product folder to your existing Shopify products and add
            the images for you.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild>
            <Link href="/stores/new">Add your first store</Link>
          </Button>
        </CardFooter>
      </Card>
    </>
  );
}
