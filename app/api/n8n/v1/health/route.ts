import { jsonResponse, resolveRequestId } from "@/lib/n8n/handler";

export const dynamic = "force-dynamic";

/**
 * GET /api/n8n/v1/health — PUBLIC liveness check for n8n / uptime monitors.
 * Deliberately static: no authentication, no database access, no store or
 * workspace information, so it can't leak anything or be used to probe keys.
 */
export function GET(request: Request) {
  const { id } = resolveRequestId(request);
  return jsonResponse(id, 200, { ok: true, service: "product-image-sync", version: "v1" });
}
