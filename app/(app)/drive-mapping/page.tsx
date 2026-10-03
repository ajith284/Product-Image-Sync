import { AlertCircleIcon, CheckCircle2Icon, FolderIcon, FolderTreeIcon, StoreIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listDriveMappings } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Drive Mapping" };

export default async function Page() {
  const ctx = await requireWorkspace();
  const stores = await listDriveMappings(ctx.workspace.workspaceId);

  return (
    <>
      <PageHeader
        title="Drive Mapping"
        description="The Google Drive category folder currently connected to each store. Product code and product folders inside it are discovered automatically."
      />

      {stores.length === 0 ? (
        <EmptyState
          icon={StoreIcon}
          title="No stores yet."
          description="Add a store first, then connect Google Drive and choose a category folder."
          action={
            <Button asChild>
              <Link href="/stores/new">Add Store</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4">
          {stores.map((store) => {
            const connected = store.drive?.connection_status === "connected";
            return (
              <Card key={store.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid gap-1">
                      <CardTitle>{store.name}</CardTitle>
                      <CardDescription>{store.shopify_domain ?? "Shopify domain not set"}</CardDescription>
                    </div>
                    <Badge variant={connected ? "default" : "outline"}>{connected ? "Drive connected" : "Drive not connected"}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {connected ? (
                    <div className="grid gap-1 text-sm">
                      <span className="text-muted-foreground">Google account</span>
                      <span className="font-medium">{store.drive?.google_account_email ?? "Connected account"}</span>
                    </div>
                  ) : null}

                  {store.categories.length === 0 ? (
                    <Alert>
                      <FolderTreeIcon />
                      <AlertDescription>No category folder is selected. Open this store and add one category folder.</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="grid gap-2">
                      <p className="text-sm font-medium">Connected category {store.categories.length > 1 ? "folders" : "folder"}</p>
                      <div className="grid gap-2">
                        {store.categories.map((category) => (
                          <div key={category.id} className="flex items-center gap-3 rounded-lg border p-3">
                            <span className="flex size-9 items-center justify-center rounded-md bg-muted">
                              <FolderIcon className="size-4" />
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium break-words">{category.name}</p>
                              <p className="text-xs text-muted-foreground">Code folders and product folders inside are discovered during sync.</p>
                            </div>
                            {store.categories.length === 1 ? <CheckCircle2Icon className="ml-auto size-5 text-emerald-600" /> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {store.categories.length > 1 ? (
                    <Alert>
                      <AlertCircleIcon />
                      <AlertDescription>
                        Your workflow is category-by-category. Keep only one category folder connected before pressing Start Sync.
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  <div>
                    <Button variant="outline" asChild>
                      <Link href={`/stores/${store.id}`}>Manage Drive & Sync</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
