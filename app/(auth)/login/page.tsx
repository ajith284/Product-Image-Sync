import Link from "next/link";

import { login } from "@/app/(auth)/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthForm } from "@/components/auth/auth-form";
import { MESSAGES } from "@/lib/errors";
import { safeNextPath } from "@/lib/routes";

export const metadata = { title: "Sign in" };

const NOTICES: Record<string, string> = {
  expired: MESSAGES.sessionExpired,
  signed_out: "You've been signed out.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, reason } = await searchParams;
  const nextPath = typeof next === "string" ? safeNextPath(next) : undefined;
  const notice = typeof reason === "string" ? NOTICES[reason] : undefined;

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
      <AuthForm action={login} mode="login" next={nextPath} notice={notice} />
    </AuthCard>
  );
}
