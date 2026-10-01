import type { EmailOtpType } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

import { appRedirect } from "@/lib/app-url";
import { safeNextPath } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";

/**
 * Handles links from Supabase auth emails.
 * Supports both the PKCE `code` flow (default templates) and `token_hash` templates.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"));

  const supabase = await createClient();
  let ok = false;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    ok = !error;
  }

  // Configured site URL only (behind a tunnel request.nextUrl.origin is https://localhost:3000).
  return appRedirect(ok ? next : "/auth/error");
}
