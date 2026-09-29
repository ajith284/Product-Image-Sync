import Link from "next/link";

import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Link expired" };

export default function AuthErrorPage() {
  return (
    <AuthCard
      title="This link didn't work"
      description="It may have expired or already been used. Please sign in, or sign up again to get a new link."
    >
      <Button asChild className="w-full">
        <Link href="/login">Go to sign in</Link>
      </Button>
    </AuthCard>
  );
}
