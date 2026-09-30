"use client";

import { AlertTriangleIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <EmptyState
      icon={AlertTriangleIcon}
      title="Something went wrong"
      description="We couldn't load this page. Please try again. If it keeps happening, sign out and back in."
      action={<Button onClick={reset}>Try again</Button>}
    />
  );
}
