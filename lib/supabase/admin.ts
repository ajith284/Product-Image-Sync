import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env.server";
import { requirePublicEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

export class AdminClientConfigError extends Error {
  constructor() {
    super("Missing SUPABASE_SECRET_KEY (server-side). See docs/shopify-setup.md.");
    this.name = "AdminClientConfigError";
  }
}

/**
 * Supabase client with the SECRET key. Bypasses RLS.
 *
 * Use ONLY in server code that has already authorized the request (or for
 * verified webhooks), and ONLY to call the service-role RPC functions
 * (shopify_*). Never import from Client Components; never return its results
 * to the browser without filtering.
 */
export function createAdminClient() {
  const { supabaseUrl } = requirePublicEnv();
  const { SUPABASE_SECRET_KEY } = getServerEnv();
  if (!SUPABASE_SECRET_KEY) throw new AdminClientConfigError();
  return createClient<Database>(supabaseUrl, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
