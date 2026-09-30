"use client";

import { useActionState } from "react";

import type { SettingsState } from "@/app/(app)/settings/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Single-field settings form with inline success/error feedback. */
export function NameForm({
  action,
  field,
  label,
  defaultValue,
  disabled,
  hint,
}: {
  action: (state: SettingsState, formData: FormData) => Promise<SettingsState>;
  field: string;
  label: string;
  defaultValue: string;
  disabled?: boolean;
  hint?: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor={field}>{label}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id={field} name={field} defaultValue={defaultValue} disabled={disabled || pending} className="sm:max-w-sm" />
          {!disabled ? (
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          ) : null}
        </div>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      {state?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : state?.success ? (
        <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
