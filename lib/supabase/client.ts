import { createBrowserClient } from "@supabase/ssr";

import { requirePublicEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

/** Supabase client for Client Components. Uses only the publishable key; RLS applies. */
export function createClient() {
  const { supabaseUrl, supabasePublishableKey } = requirePublicEnv();
  return createBrowserClient<Database>(supabaseUrl, supabasePublishableKey);
}
