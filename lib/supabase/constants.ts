/**
 * Allowed values enforced by CHECK constraints in the database
 * (supabase/migrations/*_initial_schema.sql). Keep in sync with migrations.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const STORE_STATUSES = ["setup", "connected", "disconnected", "needs_reconnect", "error"] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

export const CONNECTION_STATUSES = ["pending", "connected", "disconnected", "needs_reconnect", "error"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const MATCHING_MODES = ["contains", "exact"] as const;
export type MatchingMode = (typeof MATCHING_MODES)[number];

export const IMAGE_TYPES = ["jpg", "jpeg", "png", "webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export const MAPPING_TYPES = ["automatic", "manual"] as const;
export type MappingType = (typeof MAPPING_TYPES)[number];

export const SYNC_JOB_STATUSES = ["pending", "running", "completed", "partially_completed", "failed"] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

export const SYNC_TRIGGER_TYPES = ["manual", "scheduled"] as const;
export type SyncTriggerType = (typeof SYNC_TRIGGER_TYPES)[number];

export const SYNC_ITEM_STATUSES = [
  "pending",
  "matched",
  "synced",
  "no_product_found",
  "multiple_matches",
  "skipped",
  "upload_failed",
] as const;
export type SyncItemStatus = (typeof SYNC_ITEM_STATUSES)[number];

export const IMAGE_UPLOAD_STATUSES = ["pending", "uploaded", "failed", "skipped"] as const;
export type ImageUploadStatus = (typeof IMAGE_UPLOAD_STATUSES)[number];

export const INTEGRATION_PROVIDERS = ["shopify", "google_drive"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
