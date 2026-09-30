"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireWorkspace, WORKSPACE_COOKIE, workspaceCookieOptions } from "@/lib/workspace";

/** Switch the current workspace. Only workspaces the user is a member of are accepted. */
export async function switchWorkspace(workspaceId: string) {
  const ctx = await requireWorkspace();
  const id = z.uuid().safeParse(workspaceId);
  const target = id.success ? ctx.memberships.find((m) => m.workspaceId === id.data) : undefined;
  if (!target) return { error: "You do not have access to this workspace." };

  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, target.workspaceId, workspaceCookieOptions);
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
