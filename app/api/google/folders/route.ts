import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { DriveApiError } from "@/lib/google/client";
import { authorizeDriveBrowse } from "@/lib/google/browse-access";
import { GoogleFlowError, type GoogleFlowErrorCode } from "@/lib/google/errors";
import { isValidFolderRef, listFolders, MY_DRIVE } from "@/lib/google/folders";
import { getGoogleDeps, logGoogleError } from "@/lib/google/runtime";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  storeId: z.string(),
  parentFolderId: z.string().max(200).optional(),
  search: z.string().trim().max(100).optional(),
  pageToken: z.string().max(2048).optional(),
});

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const STATUS: Partial<Record<GoogleFlowErrorCode, number>> = {
  invalid_folder: 400,
  not_a_folder: 400,
  folder_inaccessible: 404,
  drive_forbidden: 403,
  google_not_connected: 409,
  not_connected: 409,
  needs_reconnect: 409,
  connection_expired: 409,
  not_configured: 503,
  drive_api_disabled: 502,
};

/**
 * POST /api/google/folders  { storeId, parentFolderId?, search?, pageToken? }
 * READ-ONLY. One page of the direct sub-folders of parentFolderId ("root" =
 * My Drive, "shared-drives" = list of shared drives) plus supported image
 * metadata. Safe fields only — never tokens or secrets.
 */
export async function POST(request: NextRequest) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Unsupported request." }, 415);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "Unsupported request." }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: "Invalid request." }, 400);
  const { storeId, search, pageToken } = parsed.data;
  const parentFolderId = parsed.data.parentFolderId || MY_DRIVE;

  const access = await authorizeDriveBrowse(storeId);
  if (!access.ok) return json({ error: access.error }, access.status);
  if (!isValidFolderRef(parentFolderId)) {
    return json({ error: new GoogleFlowError("invalid_folder").userMessage }, 400);
  }

  try {
    const listing = await listFolders(
      { storeId: access.storeId, parentFolderId, search, pageToken },
      getGoogleDeps(),
      access.settings,
    );
    return json(listing);
  } catch (error) {
    logGoogleError("folders", error);
    if (error instanceof GoogleFlowError) {
      // Prompt 6's refresh helper reports an expired/revoked grant as needs_reconnect.
      const code = error.code === "needs_reconnect" ? "connection_expired" : error.code === "not_connected" ? "google_not_connected" : error.code;
      return json({ error: new GoogleFlowError(code).userMessage, code }, STATUS[code] ?? 502);
    }
    if (error instanceof DriveApiError) {
      return json({ error: error.userMessage }, error.retryable ? 503 : 502);
    }
    return json({ error: "Something went wrong while reading Google Drive. Please try again." }, 500);
  }
}
