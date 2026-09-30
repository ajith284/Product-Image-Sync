"use client";

import { MailCheckIcon } from "lucide-react";
import { useActionState } from "react";

import type { AuthFormState } from "@/app/(auth)/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  mode: "login" | "signup";
  next?: string;
  notice?: string;
};

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

export function AuthForm({ action, mode, next, notice }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const isSignup = mode === "signup";

  if (state?.message) {
    return (
      <Alert>
        <MailCheckIcon />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {isSignup ? (
        <div className="grid gap-2">
          <Label htmlFor="fullName">Full name</Label>
          <Input
            id="fullName"
            name="fullName"
            autoComplete="name"
            placeholder="Ajith Kumar"
            defaultValue={state?.values?.fullName}
            aria-invalid={Boolean(state?.fieldErrors?.fullName)}
            disabled={pending}
            required
          />
          <FieldError message={state?.fieldErrors?.fullName} />
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          defaultValue={state?.values?.email}
          aria-invalid={Boolean(state?.fieldErrors?.email)}
          disabled={pending}
          required
        />
        <FieldError message={state?.fieldErrors?.email} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          aria-invalid={Boolean(state?.fieldErrors?.password)}
          disabled={pending}
          required
        />
        {state?.fieldErrors?.password ? (
          <FieldError message={state.fieldErrors.password} />
        ) : isSignup ? (
          <p className="text-sm text-muted-foreground">At least 8 characters.</p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending
          ? isSignup
            ? "Creating account…"
            : "Signing in…"
          : isSignup
            ? "Create account"
            : "Sign in"}
      </Button>
    </form>
  );
}
