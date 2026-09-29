"use client";

import { usePathname } from "next/navigation";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { mainNav, secondaryNav } from "@/lib/navigation";

const allNav = [...mainNav, ...secondaryNav];

/** Top bar: sidebar toggle + current section name. Search/notifications come later. */
export function AppHeader() {
  const pathname = usePathname();
  const current = allNav.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <span className="text-sm font-medium">{current?.title ?? "Product Image Sync"}</span>
    </header>
  );
}
