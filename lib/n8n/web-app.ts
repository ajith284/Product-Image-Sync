import "server-only";

import { z } from "zod";

import { getServerEnv } from "@/lib/env.server";

const webhookResponseSchema = z.object({
  ok: z.boolean().optional(),
  job_id: z.string().uuid(),
  status: z.string().min(1),
  claimed: z.boolean().optional(),
  reason: z.string().nullable().optional(),
});

export type WebAppSyncTriggerResult = z.infer<typeof webhookResponseSchema>;

export class N8nSyncTriggerError extends Error {
  constructor(readonly userMessage: string) {
    super("n8n_sync_trigger_failed");
    this.name = "N8nSyncTriggerError";
  }
}

export async function triggerN8nSync(storeId: string): Promise<WebAppSyncTriggerResult> {
  const env = getServerEnv();
  const url = env.N8N_SYNC_WEBHOOK_URL;
  const authorization = env.N8N_SYNC_WEBHOOK_AUTHORIZATION;
  if (!url || !authorization) {
    throw new N8nSyncTriggerError("Sync is not configured yet. Add the n8n webhook settings to the server environment.");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ store_id: storeId }),
      cache: "no-store",
      signal: AbortSignal.timeout(35_000),
    });
  } catch {
    throw new N8nSyncTriggerError("We couldn't reach the sync service. Please try again.");
  }

  let raw: unknown = null;
  try {
    raw = await response.json();
  } catch {
    // Friendly error below; never expose the raw n8n response.
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new N8nSyncTriggerError("The sync service is not active yet. Activate the Product Image Sync production workflow in n8n.");
    }
    throw new N8nSyncTriggerError("The sync service couldn't start this job. Please try again.");
  }

  const parsed = webhookResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new N8nSyncTriggerError("The sync service returned an unexpected response. Please try again.");
  }
  return parsed.data;
}
