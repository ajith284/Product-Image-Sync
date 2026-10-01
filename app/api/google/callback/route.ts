import type { NextRequest } from "next/server";

import { appRedirect } from "@/lib/app-url";
import { getSessionUser } from "@/lib/auth";
import { handleGoogleCallback } from "@/lib/google/auth";
import { getGoogleDeps, logGoogleError, toGoogleFlowError } from "@/lib/google/runtime";

export const dynamic = "force-dynamic";

/**
 * Google OAuth redirect target (register it as an Authorized redirect URI:
 * GOOGLE_REDIRECT_URI). Codes and tokens never appear in the response: only a
 * redirect to the store page with a status/error CODE.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  // Absolute URL from configuration only (never from Host / X-Forwarded-* headers).
  const back = (path: string) => appRedirect(path, [{ name: "GOOGLE_REDIRECT_URI", value: process.env.GOOGLE_REDIRECT_URI }]);

  try {
    const result = await handleGoogleCallback(
      { query: request.nextUrl.searchParams, sessionUserId: user?.id ?? null },
      getGoogleDeps(),
    );
    return back(`/stores/${result.storeId}?google=${result.verified ? "connected" : "connected_unverified"}`);
  } catch (error) {
    logGoogleError("callback", error);
    const flow = toGoogleFlowError(error);
    return back(
      flow.storeId ? `/stores/${flow.storeId}?google_error=${flow.code}` : `/stores?google_error=${flow.code}`,
    );
  }
}
