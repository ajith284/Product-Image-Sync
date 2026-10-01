import { AlertTriangleIcon, CheckCircle2Icon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { GoogleDriveCard } from "@/components/stores/google-drive-card";
import { ProductSearchTest } from "@/components/stores/product-search-test";
import { ShopifyConnectionCard } from "@/components/stores/shopify-connection-card";
import { StoreStatusBadge } from "@/components/stores/store-status-badge";
import { formatDate } from "@/components/stores/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getStoreDetails } from "@/lib/data/stores";
import { GOOGLE_FLOW_MESSAGES, isGoogleFlowErrorCode } from "@/lib/google/errors";
import { isShopifyFlowErrorCode, SHOPIFY_FLOW_MESSAGES } from "@/lib/shopify/errors";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Store details" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

function Placeholder({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed p-4">
      <Icon className="size-5 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{text}</span>
    </div>
  );
}

export default async function StoreDetailsPage({ params, searchParams }: PageProps<"/stores/[id]">) {
  const ctx = await requireWorkspace();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { created, shopify: shopifyResult, shopify_error: shopifyError, google: googleResult, google_error: googleError } = query;

  // Store must belong to the CURRENT workspace (and be visible under RLS).
  const details = await getStoreDetails(ctx.workspace.workspaceId, id);
  if (!details) notFound();
  const { store, shopify, drive, jobs } = details;
  const canManage = hasPermission(ctx, "manageStores");
  // Temporary development tool: on in `npm run dev`; in production only with SHOW_DEV_TOOLS=true.
  const showDevTools = process.env.NODE_ENV !== "production" || process.env.SHOW_DEV_TOOLS === "true";

  return (
    <>
      <PageHeader title={store.name} description={store.shopify_domain ?? undefined} actions={<StoreStatusBadge status={store.status} />} />

      {created ? (
        <Alert>
          <CheckCircle2Icon />
          <AlertDescription>Store added. Next, connect Shopify below.</AlertDescription>
        </Alert>
      ) : null}
      {shopifyResult === "connected" ? (
        <Alert>
          <CheckCircle2Icon />
          <AlertDescription>Shopify connected and verified.</AlertDescription>
        </Alert>
      ) : shopifyResult === "connected_unverified" ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertDescription>Shopify connected, but we couldn&apos;t verify it yet. Use Verify to try again.</AlertDescription>
        </Alert>
      ) : null}
      {isShopifyFlowErrorCode(shopifyError) ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription>{SHOPIFY_FLOW_MESSAGES[shopifyError]}</AlertDescription>
        </Alert>
      ) : null}

      {googleResult === "connected" ? (
        <Alert>
          <CheckCircle2Icon />
          <AlertDescription>Google Drive connected and verified.</AlertDescription>
        </Alert>
      ) : googleResult === "connected_unverified" ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertDescription>Google Drive connected, but we couldn&apos;t verify it yet. Use Verify to try again.</AlertDescription>
        </Alert>
      ) : null}
      {isGoogleFlowErrorCode(googleError) ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertDescription>{GOOGLE_FLOW_MESSAGES[googleError]}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Store name">{store.name}</Field>
              <Field label="Status">
                <StoreStatusBadge status={store.status} />
              </Field>
              <Field label="Shopify domain">{store.shopify_domain ?? "—"}</Field>
              <Field label="Added">{formatDate(store.created_at)}</Field>
            </dl>
          </CardContent>
        </Card>

        <ShopifyConnectionCard
          storeId={store.id}
          storeShopDomain={store.shopify_domain}
          connection={shopify}
          canManage={canManage}
        />

        <GoogleDriveCard storeId={store.id} connection={drive} canManage={canManage} />

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCwIcon className="size-4" /> Sync
            </CardTitle>
            <CardDescription>Recent image syncs for this store.</CardDescription>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <Placeholder icon={RefreshCwIcon} text="No sync jobs" />
            ) : (
              <ul className="divide-y">
                {jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                    <span>{formatDate(job.created_at)}</span>
                    <span className="text-muted-foreground">
                      {job.products_processed} products · {job.images_uploaded} images
                    </span>
                    <Badge variant="outline">{job.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {showDevTools && shopify?.connection_status === "connected" ? <ProductSearchTest storeId={store.id} /> : null}
      </div>
    </>
  );
}
