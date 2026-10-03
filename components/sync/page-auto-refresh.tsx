"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function PageAutoRefresh({ enabled, intervalMs = 3000 }: { enabled: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, router]);
  return null;
}
