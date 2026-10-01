"use client";

import { CheckIcon, CopyIcon, KeyRoundIcon, Loader2Icon, PlusIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { createApiKeyAction, revokeApiKeyAction, type CreateKeyState } from "@/app/(app)/settings/api-keys/actions";
import { formatDate } from "@/components/stores/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Safe key metadata (never the secret or its hash). */
type KeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  storeId: string | null;
  storeName: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

const SCOPES = [
  { scope: "n8n:read", label: "Read status", description: "Read store connection status." },
  { scope: "n8n:sync", label: "Queue syncs", description: "Create (queue) sync jobs." },
  { scope: "n8n:jobs", label: "Manage jobs", description: "List, read and cancel sync jobs." },
];

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";

function CopyField({ label, value, id }: { label: string; value: string; id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>
    </div>
  );
}

function keyStatus(k: KeyRow): { label: string; variant: "default" | "secondary" | "outline" | "destructive" } {
  if (k.revokedAt) return { label: "Revoked", variant: "outline" };
  if (k.expiresAt && new Date(k.expiresAt) <= new Date()) return { label: "Expired", variant: "outline" };
  return { label: "Active", variant: "secondary" };
}

export function ApiKeysManager({
  workspaceName,
  stores,
  keys,
}: {
  workspaceName: string;
  stores: { id: string; name: string }[];
  keys: KeyRow[];
}) {
  const [state, formAction, pending] = useActionState<CreateKeyState, FormData>(createApiKeyAction, undefined);
  const [formKey, setFormKey] = useState(0);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [revoking, startRevoke] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // The plaintext secret lives only in this component's memory until dismissed.
  const created = state?.created && state.created.id !== dismissedId ? state.created : null;

  const revoke = (id: string) => {
    setRevokingId(id);
    startRevoke(async () => {
      const r = await revokeApiKeyAction(id);
      if (r.error) toast.error(r.error);
      else toast.success("API key revoked. It stopped working immediately.");
      setRevokingId(null);
    });
  };

  return (
    <div className="grid gap-4">
      {created ? (
        <Card className="border-amber-500/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4" /> Product Image Sync API Key
            </CardTitle>
            <CardDescription>
              Name: <span className="font-medium text-foreground">{created.name}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>Copy now. You won&apos;t be able to see this secret again.</AlertTitle>
              <AlertDescription>
                Store it in n8n as a credential. If it&apos;s lost, revoke this key and create a new one.
              </AlertDescription>
            </Alert>
            <CopyField id="api-secret" label="Secret (Authorization: Bearer …)" value={created.token} />
            <CopyField id="api-signing-key" label="Signing key (only for signed requests)" value={created.signingKey} />
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  setDismissedId(created.id);
                  setFormKey((k) => k + 1);
                }}
              >
                I&apos;ve saved it
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlusIcon className="size-4" /> Create API key
          </CardTitle>
          <CardDescription>
            Workspace: <span className="font-medium text-foreground">{workspaceName}</span> (switch workspace from the
            menu to create keys for another one).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form key={formKey} action={formAction} className="grid gap-4">
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" name="name" placeholder="n8n Production" maxLength={80} required />
            </div>
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor="key-store">Store access</Label>
              <select id="key-store" name="storeId" className={selectClass} defaultValue="">
                <option value="">All stores in this workspace</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    Only {s.name}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Permissions</legend>
              {SCOPES.map((s) => (
                <label key={s.scope} className="flex items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary/50">
                  <input type="checkbox" name="scopes" value={s.scope} defaultChecked className="mt-0.5 size-4 accent-primary" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">
                      {s.label} <code className="text-xs text-muted-foreground">{s.scope}</code>
                    </span>
                    <span className="text-muted-foreground">{s.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor="key-expiry">Expires</Label>
              <select id="key-expiry" name="expiresInDays" className={selectClass} defaultValue="">
                <option value="">Never (revoke manually)</option>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In 1 year</option>
              </select>
            </div>
            {state?.error ? (
              <Alert variant="destructive">
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            ) : null}
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
                Create API key
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keys</CardTitle>
          <CardDescription>Only a short prefix is shown. Secrets are never stored — only a hash.</CardDescription>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No API keys yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {keys.map((k) => {
                const status = keyStatus(k);
                const active = status.label === "Active";
                return (
                  <li key={k.id} className="grid gap-2 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="grid min-w-0 gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium break-all">{k.name}</span>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </div>
                      <code className="text-xs break-all text-muted-foreground">{k.keyPrefix}_…</code>
                      <div className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} variant="outline" className="font-mono text-[11px]">
                            {s}
                          </Badge>
                        ))}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {k.storeName ? `Only ${k.storeName}` : "All stores"} · Created {formatDate(k.createdAt)} · Last used{" "}
                        {k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}
                        {k.expiresAt ? ` · Expires ${formatDate(k.expiresAt)}` : ""}
                        {k.revokedAt ? ` · Revoked ${formatDate(k.revokedAt)}` : ""}
                      </span>
                    </div>
                    {active ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="text-destructive" disabled={revoking}>
                            {revokingId === k.id ? <Loader2Icon className="animate-spin" /> : <ShieldAlertIcon />}
                            Revoke
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke “{k.name}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Requests using this key will fail immediately. This can&apos;t be undone — create a new key
                              if you need access again.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction variant="destructive" onClick={() => revoke(k.id)}>
                              Revoke key
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
