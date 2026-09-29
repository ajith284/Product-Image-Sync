"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { friendlyAuthError } from "@/lib/auth-errors";
import { publicEnv } from "@/lib/env";
import { LOGIN_PATH, safeNextPath } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState = {
  error?: string;
  message?: string;
  fieldErrors?: Partial<Record<"email" | "password", string>>;
  email?: string;
} | undefined;

const loginSchema = z.object({
  email: z.email("Enter a valid email address.").trim().toLowerCase(),
  password: z.string().min(1, "Enter your password."),
});

const signupSchema = z.object({
  email: z.email("Enter a valid email address.").trim().toLowerCase(),
  password: z.string().min(8, "Use at least 8 characters.").max(72, "Use at most 72 characters."),
});

function fieldErrors(error: z.ZodError) {
  const out: Partial<Record<"email" | "password", string>> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if ((key === "email" || key === "password") && !out[key]) out[key] = issue.message;
  }
  return out;
}

export async function login(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const parsed = loginSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), email };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return {
      error: friendlyAuthError(error.code, "We couldn't sign you in. Please try again."),
      email,
    };
  }

  redirect(safeNextPath(formData.get("next")?.toString()));
}

export async function signup(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const parsed = signupSchema.safeParse({ email, password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${publicEnv.siteUrl}/auth/confirm` },
  });
  if (error) {
    return {
      error: friendlyAuthError(error.code, "We couldn't create your account. Please try again."),
      email,
    };
  }

  // Email confirmation disabled in Supabase → session exists immediately.
  if (data.session) redirect("/dashboard");

  return {
    message: "Check your email for a confirmation link to finish creating your account.",
    email,
  };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(LOGIN_PATH);
}
