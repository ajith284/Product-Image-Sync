"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { friendlyAuthError } from "@/lib/auth-errors";
import { publicEnv } from "@/lib/env";
import { LOGIN_PATH, safeNextPath } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";
import { WORKSPACE_COOKIE } from "@/lib/workspace";

type Field = "fullName" | "email" | "password";

export type AuthFormState =
  | {
      error?: string;
      message?: string;
      fieldErrors?: Partial<Record<Field, string>>;
      values?: Partial<Record<"fullName" | "email", string>>;
    }
  | undefined;

const email = z.email("Enter a valid email address.").trim().toLowerCase();

const loginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password."),
});

const signupSchema = z.object({
  fullName: z.string().trim().min(1, "Enter your full name.").max(100, "Use at most 100 characters."),
  email,
  password: z.string().min(8, "Use at least 8 characters.").max(72, "Use at most 72 characters."),
});

function fieldErrors(error: z.ZodError) {
  const out: Partial<Record<Field, string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as Field;
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export async function login(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const values = { email: String(formData.get("email") ?? "") };
  const parsed = loginSchema.safeParse({ ...values, password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return {
      error: friendlyAuthError(error.code, "We couldn't sign you in. Please try again."),
      values,
    };
  }

  redirect(safeNextPath(formData.get("next")?.toString()));
}

export async function signup(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const values = {
    fullName: String(formData.get("fullName") ?? ""),
    email: String(formData.get("email") ?? ""),
  };
  const parsed = signupSchema.safeParse({ ...values, password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  // The database trigger creates the profile, a "My Workspace" workspace and
  // the owner membership in the same transaction as the new auth user.
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${publicEnv.siteUrl}/auth/confirm`,
    },
  });
  if (error) {
    return {
      error: friendlyAuthError(error.code, "We couldn't create your account. Please try again."),
      values,
    };
  }

  // Email confirmation disabled in Supabase → a session exists immediately.
  if (data.session) redirect("/dashboard");

  return {
    message: `We sent a confirmation link to ${parsed.data.email}. Open it to finish creating your account.`,
    values,
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const cookieStore = await cookies();
  cookieStore.delete(WORKSPACE_COOKIE);
  redirect(`${LOGIN_PATH}?reason=signed_out`);
}
