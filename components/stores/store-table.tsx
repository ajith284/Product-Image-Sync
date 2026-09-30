import Link from "next/link";

import { StoreCard } from "@/components/stores/store-card";
import { StoreStatusBadge } from "@/components/stores/store-status-badge";
import { formatDate, type StoreListItem } from "@/components/stores/types";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Table on lg+ screens, stacked cards on mobile. */
export function StoreTable({ stores }: { stores: StoreListItem[] }) {
  return (
    <>
      <Card className="hidden p-0 lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Store</TableHead>
              <TableHead>Shopify domain</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="pr-4 text-right">Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stores.map((store) => (
              <TableRow key={store.id} className="relative">
                <TableCell className="pl-4 font-medium">
                  <Link href={`/stores/${store.id}`} className="after:absolute after:inset-0">
                    {store.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{store.shopify_domain ?? "—"}</TableCell>
                <TableCell>
                  <StoreStatusBadge status={store.status} />
                </TableCell>
                <TableCell className="pr-4 text-right text-muted-foreground">
                  {formatDate(store.created_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <div className="grid gap-3 lg:hidden">
        {stores.map((store) => (
          <StoreCard key={store.id} store={store} />
        ))}
      </div>
    </>
  );
}
