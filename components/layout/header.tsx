"use client";

import { usePathname } from "next/navigation";

import { UserMenu, type MenuUser } from "@/components/layout/user-menu";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { pageTitle } from "@/lib/navigation";
import { ROLE_LABELS } from "@/lib/permissions";
import type { WorkspaceMembership } from "@/lib/workspace";

export function AppHeader({ user, workspace }: { user: MenuUser; workspace: WorkspaceMembership }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      <h2 className="truncate text-sm font-medium">{pageTitle(pathname)}</h2>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <span className="truncate text-sm text-muted-foreground">{workspace.workspaceName}</span>
          <Badge variant="secondary">{ROLE_LABELS[workspace.role]}</Badge>
        </div>
        <UserMenu user={user} />
      </div>
    </header>
  );
}
