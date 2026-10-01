import "server-only";

import { createN8nRepository, type N8nRepository } from "@/lib/n8n/repository";

/** Production repository (service-role Supabase client). Replaced in tests. */
export function getN8nRepository(): N8nRepository {
  return createN8nRepository();
}
