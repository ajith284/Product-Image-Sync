import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { hasSupabaseEnv, publicEnv } from "@/lib/env";
import {
  DEFAULT_AUTHENTICATED_PATH,
  LOGIN_PATH,
  isGuestOnlyPath,
  isPublicPath,
} from "@/lib/routes";

/**
 * Refreshes the Supabase session cookie on every request and performs
 * optimistic route protection. Pages/layouts still verify the user themselves.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!hasSupabaseEnv) {
    return response;
  }

  // Remember whether the browser *had* a session cookie, so an invalid one can be
  // reported as "session expired" rather than a plain sign-in prompt.
  const hadSessionCookie = request.cookies
    .getAll()
    .some(
      (c) =>
        c.name.startsWith("sb-") &&
        c.name.includes("-auth-token") &&
        !c.name.endsWith("-code-verifier"),
    );

  const supabase = createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and getClaims().
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);
  const { pathname, search } = request.nextUrl;

  const redirectTo = (path: string, params: Record<string, string | undefined> = {}) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    const redirect = NextResponse.redirect(url);
    // Keep refreshed session cookies on the redirect.
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  };

  if (!isSignedIn && !isPublicPath(pathname)) {
    const next = pathname === "/" ? undefined : `${pathname}${search}`;
    return redirectTo(LOGIN_PATH, { next, reason: hadSessionCookie ? "expired" : undefined });
  }

  if (isSignedIn && (pathname === "/" || isGuestOnlyPath(pathname))) {
    return redirectTo(DEFAULT_AUTHENTICATED_PATH);
  }

  return response;
}
