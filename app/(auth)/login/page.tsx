import Link from "next/link";

import { login } from "@/app/(auth)/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthForm } from "@/components/auth/auth-form";
import { safeNextPath } from "@/lib/routes";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? safeNextPath(next) : undefined;

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back. Sign in to manage your stores."
      footer={
        <>
          New here?{" "}
          <Link href="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <AuthForm
        action={login}
        submitLabel="Sign in"
        pendingLabel="Signing in…"
        passwordAutoComplete="current-password"
        next={nextPath}
      />
    </AuthCard>
  );
}
