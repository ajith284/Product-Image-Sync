import { updateProfile, updateWorkspaceName } from "@/app/(app)/settings/actions";
import { NameForm } from "@/components/settings/name-form";
import { PageHeader } from "@/components/shared/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listMembers } from "@/lib/data/stores";
import { ROLE_LABELS } from "@/lib/permissions";
import type { WorkspaceRole } from "@/lib/supabase/constants";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireWorkspace();
  const members = await listMembers(ctx.workspace.workspaceId);
  const canEditWorkspace = hasPermission(ctx, "manageWorkspace");

  return (
    <>
      <PageHeader title="Settings" description="Your profile and workspace." />

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>How you appear to your team.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <NameForm action={updateProfile} field="fullName" label="Full name" defaultValue={ctx.user.fullName ?? ""} />
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={ctx.user.email ?? ""} disabled className="sm:max-w-sm" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>
            Your role: <Badge variant="secondary">{ROLE_LABELS[ctx.workspace.role]}</Badge>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <NameForm
            action={updateWorkspaceName}
            field="name"
            label="Workspace name"
            defaultValue={ctx.workspace.workspaceName}
            disabled={!canEditWorkspace}
            hint={canEditWorkspace ? undefined : "Only owners and admins can rename the workspace."}
          />
          <div className="grid gap-3">
            <h3 className="text-sm font-medium">Members ({members.length})</h3>
            <ul className="divide-y rounded-lg border">
              {members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-3 p-3">
                  <Avatar className="size-8">
                    <AvatarFallback>{(m.fullName || "?").charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {m.fullName || "Unnamed member"}
                    {m.user_id === ctx.user.id ? <span className="text-muted-foreground"> (you)</span> : null}
                  </span>
                  <Badge variant="outline">{ROLE_LABELS[m.role as WorkspaceRole] ?? m.role}</Badge>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">Inviting teammates will be available in a later phase.</p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
