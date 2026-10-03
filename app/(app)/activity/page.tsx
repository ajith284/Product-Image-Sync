import { ActivityIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { listActivity } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Activity" };

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default async function Page() {
  const ctx = await requireWorkspace();
  const activity = await listActivity(ctx.workspace.workspaceId);

  return (
    <>
      <PageHeader title="Activity" description="A readable history of store connections, sync jobs, and other workspace events." />

      {activity.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="No activity yet." description="Connection and sync events will appear here." />
      ) : (
        <Card>
          <CardContent className="px-0">
            <ul className="divide-y">
              {activity.map((row) => (
                <li key={row.id} className="grid gap-2 px-6 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div className="min-w-0">
                    <p className="text-sm font-medium break-words">{row.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.store_name} · {formatDateTime(row.created_at)}
                    </p>
                  </div>
                  <Bade variant="outline" className="max-w-full truncate">
                    {row.event_type.replaceAll("_", " ")}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
