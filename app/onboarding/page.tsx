import { redirect } from "next/navigation";

import { signOut } from "@/app/(auth)/actions";
import { OnboardingForm } from "@/app/onboarding/onboarding-form";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { LOGIN_PATH } from "@/lib/routes";
import { loadWorkspaceContext } from "@/lib/workspace";

export const metadata = { title: "Set up your workspace" };

/** Shown only to signed-in users who don't belong to any workspace. */
export default async function OnboardingPage() {
  const ctx = await loadWorkspaceContext();
  if (!ctx) redirect(LOGIN_PATH);
  if (ctx.workspace) redirect("/dashboard");

  return (
    <AuthCard
      title="Create your workspace"
      description="A workspace holds your Shopify stores, Google Drive folders and sync history."
      footer={
        <form action={signOut}>
          <Button variant="link" type="submit" className="h-auto p-0 text-muted-foreground">
            Log out
          </Button>
        </form>
      }
    >
      <OnboardingForm />
    </AuthCard>
  );
}
