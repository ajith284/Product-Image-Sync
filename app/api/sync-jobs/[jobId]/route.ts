import { NextResponse } from "next/server";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { loadWorkspaceContext, SessionExpiredError } from "@/lib/workspace";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  if (!z.uuid().safeParse(jobId).success) return json({ error: "Invalid sync job." }, 400);

  let ctx;
  try {
    ctx = await loadWorkspaceContext();
  } catch (error) {
    if (error instanceof SessionExpiredError) return json({ error: "Your session expired." }, 401);
    return json({ error: "We couldn't load your workspace." }, 500);
  }
  if (!ctx?.workspace) return json({ error: "Please sign in again." }, 401);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sync_jobs")
    .select(
      "id, store_id, status, created_at, started_at, completed_at, products_processed, products_synced, images_uploaded, items_total, items_skipped, items_review, items_failed, warnings_count, errors_count, error_code, error_message",
    )
    .eq("id", jobId)
    .eq("workspace_id", ctx.workspace.workspaceId)
    .maybeSingle();

  if (error) return json({ error: "We couldn't read the sync job." }, 500);
  if (!data) return json({ error: "Sync job not found." }, 404);

  return json({
    jobId: data.id,
    storeId: data.store_id,
    status: data.status,
    createdAt: data.created_at,
    startedAt: data.started_at,
    completedAt: data.completed_at,
    progress: {
      total: data.items_total,
      processed: data.products_processed,
      synced: data.products_synced,
      uploaded: data.images_uploaded,
      skipped: data.items_skipped,
      review: data.items_review,
      failed: data.items_failed,
      warnings: data.warnings_count,
      errors: data.errors_count,
    },
    error: data.error_message ? { code: data.error_code, message: data.error_message } : null,
  });
}
