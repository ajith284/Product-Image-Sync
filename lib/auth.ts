import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { LOGIN_PATH } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string | null;
};

/**
 * Returns the verified signed-in user, or null.
 * Uses getClaims(), which validates the JWT (never trust getSession() on the server).
 * Cached per request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
  };
});

/** Use in protected layouts, pages and server actions. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}
