"use client";

import { useActionState } from "react";

import { createWorkspace } from "@/app/onboarding/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function OnboardingForm() {
  const [state, action, pending] = useActionState(createWorkspace, undefined);
  return (
    <form action={action} className="grid gap-4">
      {state?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor="name">Workspace name</Label>
        <Input id="name" name="name" defaultValue={state?.name ?? "My Workspace"} disabled={pending} required />
        <p className="text-sm text-muted-foreground">Usually your company or brand name. You can change it later.</p>
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating workspace…" : "Create workspace"}
      </Button>
    </form>
  );
}
