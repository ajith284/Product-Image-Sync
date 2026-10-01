"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  removeGoogleCategoryRoot,
  verifyGoogleDrive,
  type GoogleActionState,
} from "@/app/(app)/stores/[id]/google-actions";
import { DriveFolderPicker } from "@/components/stores/drive-folder-picker";
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

/** Safe, display-only connection fields (no tokens ever reach the browser). */
export type GoogleDriveConnectionView = {
  connection_status: string;
  google_account_email: string | null;
  root_folder_name: string | null;
  /** Connected CATEGORY folders (e.g. "Sofa image", "Sofa bed image"). */
  category_roots: { id: string; name: string }[];
  connected_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  disconnected_at: string | null;
} | null;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/**
 * Category folders ("Sofa image", "Sofa bed image", …). Code folders (SOF-001) and
 * product folders (Milano) inside them are found automatically by the scanner.
 */
function CategoryFolders({
  storeId,
  roots,
  canManage,
  onAdd,
}: {
  storeId: string;
  roots: { id: string; name: string }[];
  canManage: boolean;
  onAdd: () => void;
}) {
  const router = useRouter();
  const [removing, startRemove] = useTransition();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const remove = (id: string) => {
    setRemovingId(id);
    startRemove(async () => {
      const r = await removeGoogleCategoryRoot(storeId, id);
      if (r?.error) toast.error(r.error);
      else toast.success(r?.message ?? "Category folder disconnected.");
      setRemovingId(null);
      router.refresh();
    });
  };
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">Category folders</span>
          <span className="text-xs text-muted-foreground">
            Connect folders like &quot;Sofa image&quot;. Code folders (SOF-001) and product folders (Milano) inside are found
            automatically.
          </span>
        </div>
        {canManage ? (
          <Button size="sm" variant={roots.length ? "outline" : "default"} onClick={onAdd}>
            <FolderPlusIcon /> Add category folder
          </Button>
        ) : null}
      </div>
      {roots.length === 0 ? (
        <p className="text-sm text-muted-foreground">No category folder connected yet.</p>
      ) : (
        <ul className="grid gap-1">
          {roots.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <FolderIcon className="size-4 shrink-0 text-sky-600" />
                <span className="text-sm font-medium break-all">{r.name}</span>
              </span>
              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label={`Disconnect ${r.name}`}
                  disabled={removing}
                  onClick={() => remove(r.id)}
                >
                  {removingId === r.id ? <Loader2Icon className="animate-spin" /> : <XIcon />}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GoogleDriveCard({
  storeId,
  connection,
  canManage,
}: {
  storeId: string;
  connection: GoogleDriveConnectionView;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"connect" | "verify" | "disconnect" | null>(null);
  const [result, setResult] = useState<GoogleActionState>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);

  const run = (kind: "connect" | "verify" | "disconnect", action: (id: string) => Promise<GoogleActionState>) => {
    setBusy(kind);
    setResult(undefined);
    startTransition(async () => {
      const r = await action(storeId);
      setResult(r);
      setBusy(null);
    });
  };

  const status = connection?.connection_status;
  const active = Boolean(connection) && status !== "disconnected";
  const connected = status === "connected";
  const needsAttention = status === "needs_reconnect" || status === "error";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDriveIcon className="size-4" /> Google Drive
        </CardTitle>
        <CardDescription>Where your product image folders live. We only read them.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {active && connection ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {connected ? (
                <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
                  <CheckCircle2Icon className="size-3.5" /> Google Drive Connected ✓
                </Badge>
              ) : needsAttention ? (
                <Badge variant="outline" className="gap-1 border-amber-500 text-amber-700 dark:text-amber-400">
                  <AlertTriangleIcon className="size-3.5" />
                  {status === "needs_reconnect" ? "Needs reconnect" : "Problem"}
                </Badge>
              ) : (
                <Badge variant="secondary">Verifying</Badge>
              )}
            </div>
            {connection.last_error && !connected ? (
              <p className="text-sm text-muted-foreground">{connection.last_error}</p>
            ) : null}
            <dl className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Row label="Account">{connection.google_account_email ?? "—"}</Row>
              </div>
              <Row label="Connected">{connection.connected_at ? formatDate(connection.connected_at) : "—"}</Row>
              <Row label="Last verified">
                {connection.last_verified_at ? formatDate(connection.last_verified_at) : "Not yet"}
              </Row>
            </dl>
            <CategoryFolders
              storeId={storeId}
              roots={connection.category_roots ?? []}
              canManage={canManage && connected}
              onAdd={() => setPickerOpen(true)}
            />
            {canManage && connected && pickerOpen ? (
              <DriveFolderPicker
                storeId={storeId}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                currentRootName={null}
                mode="category"
                connectedRootIds={(connection.category_roots ?? []).map((r) => r.id)}
              />
            ) : null}
          </>
        ) : (
          <div className="grid gap-1 rounded-lg border border-dashed p-4">
            <span className="text-sm font-medium">Not connected</span>
            <span className="text-sm text-muted-foreground">
              {connection?.disconnected_at
                ? `Disconnected on ${formatDate(connection.disconnected_at)}.`
                : "You'll sign in with Google and allow access to your Drive images. We never change or delete Drive files, and no passwords are shared with us."}
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
              <Button onClick={() => run("connect", connectGoogleDrive)} disabled={pending}>
                {busy === "connect" ? <Loader2Icon className="animate-spin" /> : <HardDriveIcon />}
                {busy === "connect" ? "Opening Google…" : "Connect Google Drive"}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => run("verify", verifyGoogleDrive)} disabled={pending}>
                  {busy === "verify" ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                  {busy === "verify" ? "Verifying…" : "Verify"}
                </Button>
                <Button variant="outline" onClick={() => run("connect", connectGoogleDrive)} disabled={pending}>
                  {busy === "connect" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                  {busy === "connect" ? "Opening Google…" : "Reconnect"}
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
                      <AlertDialogTitle>Disconnect Google Drive?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This deletes the stored Google access for this store. Nothing in your Drive or Shopify is
                        changed, and your sync history is kept. You can reconnect any time.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => run("disconnect", disconnectGoogleDrive)}>
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
