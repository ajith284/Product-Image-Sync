import type { WorkspaceRole } from "@/lib/supabase/constants";

/**
 * UI/server-action permission map. Mirrors the RLS policies in
 * supabase/migrations/*_rls_and_grants.sql — the database remains the final check.
 */
const PERMISSIONS = {
  manageStores: ["owner", "admin"],
  manageStoreSettings: ["owner", "admin"],
  manageWorkspace: ["owner", "admin"],
  manageMembers: ["owner", "admin"],
  deleteWorkspace: ["owner"],
  manageProductMappings: ["owner", "admin", "member"],
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: WorkspaceRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly WorkspaceRole[]).includes(role);
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
