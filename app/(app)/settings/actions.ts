"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { friendlyDbError, MESSAGES } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { hasPermission, requireWorkspace } from "@/lib/workspace";

export type SettingsState = { error?: string; success?: string } | undefined;

const nameSchema = (label: string, max: number) =>
  z.string().trim().min(1, `Enter ${label}.`).max(max, `Use at most ${max} characters.`);

export async function updateProfile(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const ctx = await requireWorkspace();
  const parsed = nameSchema("your full name", 100).safeParse(formData.get("fullName") ?? "");
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ full_name: parsed.data }).eq("id", ctx.user.id);
  if (error) return { error: friendlyDbError(error, "We couldn't save your profile.") };

  revalidatePath("/", "layout");
  return { success: "Profile saved." };
}

export async function updateWorkspaceName(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const ctx = await requireWorkspace();
  if (!hasPermission(ctx, "manageWorkspace")) return { error: MESSAGES.noPermission };
  const parsed = nameSchema("a workspace name", 120).safeParse(formData.get("name") ?? "");
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const supabase = await createClient();
  // Workspace id from the server-side context — never from the form.
  const { data, error } = await supabase
    .from("workspaces")
    .update({ name: parsed.data })
    .eq("id", ctx.workspace.workspaceId)
    .select("id");
  if (error) return { error: friendlyDbError(error, "We couldn't save the workspace.") };
  if (!data?.length) return { error: MESSAGES.noAccess };

  revalidatePath("/", "layout");
  return { success: "Workspace saved." };
}
