import { AlertCircleIcon, InboxIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listReviewItems } from "@/lib/data/sync";
import { requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Review" };

type Candidate = { id: string; title: string; status?: string };

function candidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Candidate => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.id === "string" && typeof row.title === "string";
  });
}

function issueLabel(status: string) {
  if (status === "no_product_found") return "No product found";
  if (status === "multiple_matches") return "Multiple matches";
  if (status === "upload_failed") return "Image upload failed";
  return status;
}

function issueDescription(status: string) {
  if (status === "no_product_found") return "No Shopify product title matched this Drive product folder. Nothing was uploaded.";
  if (status === "multiple_matches") return "More than one Shopify product matched. The sync did not guess or upload to either product.";
  if (status === "upload_failed") return "The product matched, but one or more images could not be uploaded.";
  return "This item needs attention.";
}

export default async function Page() {
  const ctx = await requireWorkspace();
  const items = await listReviewItems(ctx.workspace.workspaceId);

  return (
    <>
      <PageHeader title="Review" description="Products that were held back or had an upload problem during a real sync." />

      {items.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title="No items require review."
          description="Products with no match, multiple matches, or failed image uploads will appear here."
        />
      ) : (
        <div className="grid gap-3">
          {items.map((item) => {
            const matches = candidates(item.match_candidates);
            return (
              <Card key={item.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid gap-1">
                      <CardTitle className="text-base">{item.drive_folder_name ?? "Unnamed product folder"}</CardTitle>
                      <CardDescription>
                        {item.store_name}
                        {item.code_folder_name ? ` · ${item.code_folder_name}` : ""}
                      </CardDescription>
                    </div>
                    <Badge variant={item.status === "upload_failed" ? "destructive" : "secondary"}>{issueLabel(item.status)}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <div className="flex items-start gap-2 rounded-lg border bg-muted/20 p-3 text-sm">
                    <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                    <p>{issueDescription(item.status)}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Images found</p>
                      <p className="font-semibold tabular-nums">{item.images_found}</p>
                    </div>
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Uploaded</p>
                      <p className="font-semibold tabular-nums">{item.images_uploaded}</p>
                    </div>
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Skipped</p>
                      <p className="font-semibold tabular-nums">{item.images_skipped}</p>
                    </div>
                    <div className="rounded-md bg-muted/40 p-3">
                      <p className="text-xs text-muted-foreground">Failed</p>
                      <p className="font-semibold tabular-nums">{item.images_failed}</p>
                    </div>
                  </div>

                  {item.shopify_product_title ? (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Matched Shopify product: </span>
                      <span className="font-medium">{item.shopify_product_title}</span>
                      {item.product_status ? <span className="text-muted-foreground"> · {item.product_status}</span> : null}
                    </div>
                  ) : null}

                  {matches.length > 0 ? (
                    <div className="grid gap-2">
                      <p className="text-sm font-medium">Shopify candidates</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {matches.map((match) => (
                          <div key={match.id} className="rounded-lg border p-3">
                            <p className="text-sm font-medium">{match.title}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{match.status ?? "Shopify product"}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {item.error_message ? <p className="text-sm text-destructive">{item.error_message}</p> : null}

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/stores/${item.store_id}`}>Open Store</Link>
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
