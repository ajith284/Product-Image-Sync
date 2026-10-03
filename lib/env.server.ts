import "server-only";

import { z } from "zod";

/**
 * Server-only environment variables. Importing this file from a Client
 * Component fails the build, so secrets here can never reach the browser.
 * Shopify variables are validated separately in lib/shopify/config.ts.
 */
const serverEnvSchema = z.object({
  /** Supabase secret key (sb_secret_…). Bypasses RLS — server code only. */
  SUPABASE_SECRET_KEY: z.string().trim().min(1).optional(),
  /** Production n8n webhook used by the authenticated web app to start a sync. */
  N8N_SYNC_WEBHOOK_URL: z.string().url().optional(),
  /** Exact Authorization header value configured on the n8n Web App Trigger credential. */
  N8N_SYNC_WEBHOOK_AUTHORIZATION: z.string().trim().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report which variables are invalid, never their values.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server environment variables: ${names}`);
  }
  return parsed.data;
}
