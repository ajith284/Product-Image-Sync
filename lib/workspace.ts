import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getSessionUser } from "@/lib/auth";
import { isSessionError } from "@/lib/errors";
import { can, type Permission } from "@/lib/permissions";
import { LOGIN_PATH } from "@/lib/routes";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/supabase/constants";
import { createClient } from "@/lib/supabase/server";

/** Remembers which workspace the user last selected. Always re-validated against membership. */
export const WORKSPACE_COOKIE = "pis_workspace";

export type WorkspaceMembership = {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
};

export type WorkspaceContext = {
  user: { id: string; email: string | null; fullName: string | null };
  memberships: WorkspaceMembership[];
  /** The workspace the current request operates in (always one the user belongs to). */
  workspace: WorkspaceMembership;
};

export class SessionExpiredError extends Error {
  constructor() {
    super("session_expired");
  }
}

function isRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/**
 * Loads the signed-in user's memberships (RLS-scoped) and resolves the current
 * workspace. Returns null when signed out; `workspace` is null when the user
 * belongs to no workspace. Cached per request.
 */
export const loadWorkspaceContext = cache(async () => {
  const user = await getSessionUser();
  if (!user) return null;

  const supabase = await createClient();
  const [membersRes, profileRes] = await Promise.all([
    supabase
      .from("workspace_members")
      .select("role, created_at, workspace:workspaces(id, name)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);

  if (membersRes.error) {
    if (isSessionError(membersRes.error)) throw new SessionExpiredError();
    throw new Error("Could not load workspaces");
  }

  const memberships: WorkspaceMembership[] = (membersRes.data ?? [])
    .filter((m) => m.workspace && isRole(m.role))
    .map((m) => ({
      workspaceId: m.workspace!.id,
      workspaceName: m.workspace!.name,
      role: m.role as WorkspaceRole,
    }));

  const cookieStore = await cookies();
  const preferred = cookieStore.get(WORKSPACE_COOKIE)?.value;
  // Never trust the cookie: it only selects among workspaces the DB says we belong to.
  const workspace =
    memberships.find((m) => m.workspaceId === preferred) ?? memberships[0] ?? null;

  return {
    user: { id: user.id, email: user.email, fullName: profileRes.data?.full_name ?? null },
    memberships,
    workspace,
  };
});

/**
 * Use in every protected page/layout/action:
 * session → workspace membership → (optional) permission.
 */
export async function requireWorkspace(): Promise<WorkspaceContext> {
  let ctx: Awaited<ReturnType<typeof loadWorkspaceContext>>;
  try {
    ctx = await loadWorkspaceContext();
  } catch (error) {
    if (error instanceof SessionExpiredError) redirect(`${LOGIN_PATH}?reason=expired`);
    throw error;
  }
  if (!ctx) redirect(LOGIN_PATH);
  if (!ctx.workspace) redirect("/onboarding");
  return ctx as WorkspaceContext;
}

export function hasPermission(ctx: WorkspaceContext, permission: Permission) {
  return can(ctx.workspace.role, permission);
}

export const workspaceCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};
