"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { friendlyDbError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE, workspaceCookieOptions } from "@/lib/workspace";

export type OnboardingState = { error?: string; name?: string } | undefined;

const schema = z.object({
  name: z.string().trim().min(1, "Enter a workspace name.").max(120, "Use at most 120 characters."),
});

export async function createWorkspace(_prev: OnboardingState, formData: FormData): Promise<OnboardingState> {
  await requireUser();
  const name = String(formData.get("name") ?? "");
  const parsed = schema.safeParse({ name });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message, name };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: parsed.data.name });
  if (error || !data) return { error: friendlyDbError(error, "We couldn't create your workspace."), name };

  const cookieStore = await cookies();
  cookieStore.set(WORKSPACE_COOKIE, data.id, workspaceCookieOptions);
  redirect("/dashboard");
}
