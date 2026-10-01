import "server-only";

import { DriveApiError } from "@/lib/google/client";
import { getGoogleConfig, GoogleConfigError } from "@/lib/google/config";
import type { GoogleDeps } from "@/lib/google/connection";
import { GoogleFlowError } from "@/lib/google/errors";
import { createGoogleRepository } from "@/lib/google/repository";
import { AdminClientConfigError } from "@/lib/supabase/admin";

/** Production dependencies. Missing configuration becomes a friendly "not_configured". */
export function getGoogleDeps(): GoogleDeps {
  try {
    return { config: getGoogleConfig(), repo: createGoogleRepository() };
  } catch (error) {
    if (error instanceof GoogleConfigError || error instanceof AdminClientConfigError) {
      // Names of missing/invalid variables only — never values.
      console.error(`[google] not configured: ${error.message}`);
      throw new GoogleFlowError("not_configured");
    }
    throw error;
  }
}

/** Log without secrets: error class + code only. */
export function logGoogleError(scope: string, error: unknown) {
  if (error instanceof GoogleFlowError) console.warn(`[google] ${scope}: ${error.code}`);
  else if (error instanceof DriveApiError) console.warn(`[google] ${scope}: drive ${error.kind} (${error.status ?? "-"})`);
  else console.error(`[google] ${scope}: ${error instanceof Error ? error.name : "unknown error"}`);
}

export function toGoogleFlowError(error: unknown, storeId?: string): GoogleFlowError {
  if (error instanceof GoogleFlowError) return error;
  return new GoogleFlowError("unknown", { storeId });
}
