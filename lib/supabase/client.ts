import { createBrowserClient } from "@supabase/ssr";

import { requirePublicEnv } from "@/lib/env";

/** Supabase client for Client Components. Uses only the publishable key; RLS applies. */
export function createClient() {
  const { supabaseUrl, supabasePublishableKey } = requirePublicEnv();
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
