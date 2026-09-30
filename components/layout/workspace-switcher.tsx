"use client";

import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { switchWorkspace } from "@/app/(app)/workspace-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { ROLE_LABELS } from "@/lib/permissions";
import type { WorkspaceMembership } from "@/lib/workspace";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function WorkspaceSwitcher({
  memberships,
  current,
}: {
  memberships: WorkspaceMembership[];
  current: WorkspaceMembership;
}) {
  const [pending, startTransition] = useTransition();

  const select = (workspaceId: string) => {
    if (workspaceId === current.workspaceId) return;
    startTransition(async () => {
      const result = await switchWorkspace(workspaceId);
      if (result?.error) toast.error(result.error);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent"
          disabled={pending}
          tooltip={current.workspaceName}
        >
          <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
            {initials(current.workspaceName) || "W"}
          </span>
          <span className="grid flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{current.workspaceName}</span>
            <span className="truncate text-xs text-muted-foreground">
              {ROLE_LABELS[current.role]}
            </span>
          </span>
          <ChevronsUpDownIcon className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
        {memberships.map((m) => (
          <DropdownMenuItem key={m.workspaceId} onSelect={() => select(m.workspaceId)}>
            <span className="flex-1 truncate">{m.workspaceName}</span>
            <span className="text-xs text-muted-foreground">{ROLE_LABELS[m.role]}</span>
            {m.workspaceId === current.workspaceId ? <CheckIcon className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {memberships.length === 1 ? (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              You belong to one workspace.
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
