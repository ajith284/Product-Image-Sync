import { n8nRoute } from "@/lib/n8n/handler";
import { requireUuid } from "@/lib/n8n/validation";

export const dynamic = "force-dynamic";

/** GET /api/n8n/v1/stores/:storeId/status — scope n8n:read. Safe status only. */
export const GET = n8nRoute<{ storeId: string }>(
  "GET /stores/:storeId/status",
  { scope: "n8n:read", rate: "read" },
  async ({ key, repo }, { storeId }) => {
    const id = requireUuid(storeId, "STORE_NOT_FOUND");
    return { body: await repo.storeStatus(key.id, id) };
  },
);
