import "server-only";

import { createDriveDownloadRepository } from "@/lib/google/download";
import { getGoogleDeps } from "@/lib/google/runtime";
import { getShopifyDeps } from "@/lib/shopify/runtime";
import { createSyncImageRepository } from "@/lib/sync/images-repository";
import { createSyncJobRepository } from "@/lib/sync/jobs-repository";
import type { WorkerDeps } from "@/lib/sync/worker";

/** Production worker dependencies (service role; Google and Shopify tokens stay server-side). */
export function getWorkerDeps(): WorkerDeps {
  return {
    jobs: createSyncJobRepository(),
    images: createSyncImageRepository(),
    google: { ...getGoogleDeps(), downloads: createDriveDownloadRepository() },
    shopify: getShopifyDeps(),
  };
}
