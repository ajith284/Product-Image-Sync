import Link from "next/link";

import { signup } from "@/app/(auth)/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthForm } from "@/components/auth/auth-form";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <AuthCard
      title="Create your account"
      description="Sync Google Drive product images to your Shopify stores."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <AuthForm action={signup} mode="signup" />
    </AuthCard>
  );
}
