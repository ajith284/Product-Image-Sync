"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ShoppingBagIcon,
  UnplugIcon,
} from "lucide-react";
import { useState, useTransition } from "react";

import {
  connectShopify,
  disconnectShopify,
  verifyShopify,
  type ShopifyActionState,
} from "@/app/(app)/stores/[id]/shopify-actions";
import { formatDate } from "@/components/stores/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Safe, display-only connection fields (no tokens ever reach the browser). */
export type ShopifyConnectionView = {
  connection_status: string;
  shop_domain: string | null;
  installed_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  refresh_token_expires_at: string | null;
  disconnected_at: string | null;
} | null;

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  connected: { label: "Connected", tone: "ok" },
  pending: { label: "Verifying", tone: "muted" },
  needs_reconnect: { label: "Needs reconnect", tone: "warn" },
  error: { label: "Problem", tone: "warn" },
  disconnected: { label: "Disconnected", tone: "muted" },
};

function Row({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

export function ShopifyConnectionCard({
  storeId,
  storeShopDomain,
  connection,
  canManage,
}: {
  storeId: string;
  storeShopDomain: string | null;
  connection: ShopifyConnectionView;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"connect" | "verify" | "disconnect" | null>(null);
  const [result, setResult] = useState<ShopifyActionState>(undefined);

  const run = (kind: "connect" | "verify" | "disconnect", action: (id: string) => Promise<ShopifyActionState>) => {
    setBusy(kind);
    setResult(undefined);
    startTransition(async () => {
      const r = await action(storeId);
      setResult(r);
      setBusy(null);
    });
  };

  const active = connection && connection.connection_status !== "disconnected";
  const status = connection ? STATUS[connection.connection_status] ?? STATUS.error : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingBagIcon className="size-4" /> Shopify
        </CardTitle>
        <CardDescription>Lets us add images to your existing products. Nothing else is changed.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {active && status ? (
          <>
            <div className="flex items-center gap-2">
              {status.tone === "ok" ? (
                <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
                  <CheckCircle2Icon className="size-3.5" /> {status.label}
                </Badge>
              ) : status.tone === "warn" ? (
                <Badge variant="outline" className="gap-1 border-amber-500 text-amber-700 dark:text-amber-400">
                  <AlertTriangleIcon className="size-3.5" /> {status.label}
                </Badge>
              ) : (
                <Badge variant="secondary">{status.label}</Badge>
              )}
            </div>
            {connection.last_error && connection.connection_status !== "connected" ? (
              <p className="text-sm text-muted-foreground">{connection.last_error}</p>
            ) : null}
            <dl className="grid grid-cols-2 gap-3">
              <Row label="Store" className="col-span-2">{connection.shop_domain ?? storeShopDomain ?? "—"}</Row>
              <Row label="Installed">{connection.installed_at ? formatDate(connection.installed_at) : "—"}</Row>
              <Row label="Last verified">{connection.last_verified_at ? formatDate(connection.last_verified_at) : "Not yet"}</Row>
            </dl>
          </>
        ) : (
          <div className="grid gap-1 rounded-lg border border-dashed p-4">
            <span className="text-sm font-medium">Not connected</span>
            <span className="text-sm text-muted-foreground">
              {connection?.disconnected_at
                ? `Disconnected on ${formatDate(connection.disconnected_at)}. ${connection.last_error ?? ""}`
                : `You'll approve access in Shopify for ${storeShopDomain ?? "your store"}. No passwords or API keys needed.`}
            </span>
          </div>
        )}

        {result?.error ? (
          <Alert variant="destructive">
            <AlertDescription>{result.error}</AlertDescription>
          </Alert>
        ) : result?.message ? (
          <Alert>
            <ShieldCheckIcon />
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        ) : null}

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {!active ? (
              <Button onClick={() => run("connect", connectShopify)} disabled={pending || !storeShopDomain}>
                {busy === "connect" ? <Loader2Icon className="animate-spin" /> : <ShoppingBagIcon />}
                {busy === "connect" ? "Opening Shopify…" : "Connect Shopify"}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => run("verify", verifyShopify)} disabled={pending}>
                  {busy === "verify" ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                  {busy === "verify" ? "Verifying…" : "Verify"}
                </Button>
                <Button variant="outline" onClick={() => run("connect", connectShopify)} disabled={pending}>
                  {busy === "connect" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                  {busy === "connect" ? "Opening Shopify…" : "Reconnect"}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={pending}>
                      {busy === "disconnect" ? <Loader2Icon className="animate-spin" /> : <UnplugIcon />}
                      Disconnect
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Disconnect Shopify?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes Product Image Sync from {connection?.shop_domain ?? "this Shopify store"} and
                        deletes the stored access. Images already uploaded stay in Shopify. Your sync history,
                        activity and product mappings are kept. You can reconnect any time.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => run("disconnect", disconnectShopify)}
                      >
                        Disconnect
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only workspace owners and admins can manage this connection.</p>
        )}
      </CardContent>
    </Card>
  );
}
