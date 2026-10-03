import "server-only";

import { createShopifyClient, ShopifyApiError, type ShopifyAdminClient } from "@/lib/shopify/client";
import { refreshTokenIfNeeded, type ConnectionDeps } from "@/lib/shopify/connection";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import { validateImageForUpload } from "@/lib/shopify/media-validation";
import {
  SyncImageAccessError,
  type SyncImageRecord,
  type SyncImageRepository,
} from "@/lib/sync/images-repository";

/**
 * Shopify media upload service (Admin GraphQL API, checked against 2026-07).
 *
 *   1. product(id)            – product exists in the connected shop (read_products)
 *   2. stagedUploadsCreate     – resource IMAGE (PRODUCT_IMAGE is deprecated)
 *   3. POST multipart          – staged parameters first, file last; NO Shopify token
 *   4. fileCreate              – originalSource = resourceUrl → MediaImage ID (persisted at once)
 *   5. node(id) { fileStatus } – bounded polling until READY / FAILED
 *   6. fileUpdate              – referencesToAdd = [productId] (only attaches; nothing else changes)
 *
 * Never used: productCreateMedia (deprecated), productUpdate / productSet (product fields).
 * Never deletes media. The access token comes only from refreshTokenIfNeeded(storeId);
 * it is never accepted from callers, returned, logged or sent to the staged URL.
 * Staged upload URLs / parameters are treated as secrets: never logged or stored.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const PERMANENT_UPLOAD_ERRORS = [
  "PRODUCT_NOT_FOUND",
  "INVALID_IMAGE",
  "UNSUPPORTED_MIME_TYPE",
  "IMAGE_TOO_LARGE",
  "SCOPE_OR_PERMISSION",
  "INVALID_REQUEST",
  "IMAGE_PROCESSING_FAILED",
  "SHOPIFY_NEEDS_RECONNECT",
  "SHOP_UNAVAILABLE",
  "STORE_NOT_FOUND",
] as const;

export const RETRYABLE_UPLOAD_ERRORS = [
  "SHOPIFY_THROTTLED",
  "SHOPIFY_UNAVAILABLE",
  "NETWORK_ERROR",
  "STAGED_UPLOAD_FAILED",
  "STAGED_UPLOAD_TIMEOUT",
  "TOKEN_REFRESH_UNAVAILABLE",
  "MEDIA_PROCESSING_TIMEOUT",
  "INTERNAL_ERROR",
] as const;

export type UploadErrorCode = (typeof PERMANENT_UPLOAD_ERRORS)[number] | (typeof RETRYABLE_UPLOAD_ERRORS)[number];

const RETRYABLE = new Set<string>(RETRYABLE_UPLOAD_ERRORS);

const DEFAULT_MESSAGES: Record<UploadErrorCode, string> = {
  PRODUCT_NOT_FOUND: "The Shopify product wasn't found in this store.",
  INVALID_IMAGE: "Shopify couldn't use this image.",
  UNSUPPORTED_MIME_TYPE: "Only JPG, JPEG, PNG, WEBP, GIF and HEIC images can be uploaded.",
  IMAGE_TOO_LARGE: "Images must be 20 MB or smaller and at most 4472 × 4472 pixels.",
  SCOPE_OR_PERMISSION: "The Shopify app doesn't have permission to add product images.",
  INVALID_REQUEST: "Shopify rejected the upload request.",
  IMAGE_PROCESSING_FAILED: "Shopify couldn't process this image.",
  SHOPIFY_NEEDS_RECONNECT: "Shopify needs to be reconnected.",
  SHOP_UNAVAILABLE: "This Shopify store is unavailable (billing or plan issue).",
  STORE_NOT_FOUND: "This store wasn't found in the workspace.",
  SHOPIFY_THROTTLED: "Shopify is busy right now. We'll try again shortly.",
  SHOPIFY_UNAVAILABLE: "Shopify is temporarily unavailable. We'll try again shortly.",
  NETWORK_ERROR: "We couldn't reach Shopify. We'll try again shortly.",
  STAGED_UPLOAD_FAILED: "The image upload to Shopify failed. We'll try again shortly.",
  STAGED_UPLOAD_TIMEOUT: "The image upload to Shopify timed out. We'll try again shortly.",
  TOKEN_REFRESH_UNAVAILABLE: "We couldn't refresh the Shopify connection. We'll try again shortly.",
  MEDIA_PROCESSING_TIMEOUT: "Shopify is still processing this image. We'll check again shortly.",
  INTERNAL_ERROR: "Something went wrong while uploading. We'll try again shortly.",
};

/** Safe-to-store/show upload error. Messages never contain tokens, URLs or staged parameters. */
export class ShopifyUploadError extends Error {
  readonly code: UploadErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly publicMessage: string;

  constructor(code: UploadErrorCode, opts: { message?: string; retryAfterSeconds?: number } = {}) {
    super(`Shopify upload ${code}`);
    this.name = "ShopifyUploadError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.publicMessage = (opts.message ?? DEFAULT_MESSAGES[code]).slice(0, 500);
  }
}

function hasCode(error: ShopifyApiError, code: string) {
  return (error.graphqlErrors ?? []).some((e) => e.extensions?.code === code);
}

/**
 * Maps anything thrown during an upload to a ShopifyUploadError. Reuses the
 * existing ShopifyApiError kinds (client.ts) and ShopifyFlowError codes (connection.ts).
 */
export function classifyUploadError(error: unknown): ShopifyUploadError {
  if (error instanceof ShopifyUploadError) return error;
  if (error instanceof SyncImageAccessError) return new ShopifyUploadError("STORE_NOT_FOUND");
  if (error instanceof ShopifyApiError) {
    const retryAfterSeconds = error.retryAfterSeconds;
    switch (error.kind) {
      case "throttled":
        return new ShopifyUploadError("SHOPIFY_THROTTLED", { retryAfterSeconds });
      case "unavailable":
      case "locked":
        return new ShopifyUploadError("SHOPIFY_UNAVAILABLE", { retryAfterSeconds });
      case "network":
        return new ShopifyUploadError("NETWORK_ERROR");
      case "unauthorized":
        // 401 = token no longer valid; 403 = token valid but not allowed (scope / staff permission).
        return new ShopifyUploadError(error.status === 403 ? "SCOPE_OR_PERMISSION" : "SHOPIFY_NEEDS_RECONNECT");
      case "not_found":
        return new ShopifyUploadError("SHOPIFY_NEEDS_RECONNECT"); // shop gone / app removed
      case "payment_required":
        return new ShopifyUploadError("SHOP_UNAVAILABLE");
      case "graphql":
        if (hasCode(error, "ACCESS_DENIED")) return new ShopifyUploadError("SCOPE_OR_PERMISSION");
        return new ShopifyUploadError("INVALID_REQUEST");
    }
  }
  if (error instanceof ShopifyFlowError) {
    if (error.code === "verify_failed") return new ShopifyUploadError("TOKEN_REFRESH_UNAVAILABLE");
    if (error.code === "not_configured") {
      return new ShopifyUploadError("SHOPIFY_UNAVAILABLE", { message: "Shopify isn't configured on the server yet." });
    }
    return new ShopifyUploadError("SHOPIFY_NEEDS_RECONNECT"); // needs_reconnect, not_connected, invalid_shop_domain, …
  }
  return new ShopifyUploadError("INTERNAL_ERROR");
}

type UserError = { field?: string[] | null; message: string; code?: string | null };

/** GraphQL userErrors → upload error. Messages are Shopify's own (no secrets). */
export function classifyUserErrors(step: "staged" | "fileCreate" | "fileUpdate", errors: UserError[]): ShopifyUploadError {
  const text = errors.map((e) => `${e.code ?? ""} ${e.message}`).join(" | ");
  const message = errors.map((e) => e.message).join("; ").slice(0, 300) || undefined;
  if (/ACCESS_DENIED|access denied|permission/i.test(text)) return new ShopifyUploadError("SCOPE_OR_PERMISSION", { message });
  if (step === "fileUpdate") {
    if (/REFERENCE|product/i.test(text) && /(not exist|not found|invalid|DOES_NOT_EXIST)/i.test(text)) {
      return new ShopifyUploadError("PRODUCT_NOT_FOUND", { message });
    }
    if (/(processing|not ready|locked|NON_READY|READY)/i.test(text)) {
      return new ShopifyUploadError("MEDIA_PROCESSING_TIMEOUT", { message });
    }
  }
  if (/(too large|TOO_LARGE|size)/i.test(text)) return new ShopifyUploadError("IMAGE_TOO_LARGE", { message });
  if (/(UNACCEPTABLE|INVALID_IMAGE|EXTENSION|content type|unsupported|corrupt|not a valid image)/i.test(text)) {
    return new ShopifyUploadError("INVALID_IMAGE", { message });
  }
  return new ShopifyUploadError("INVALID_REQUEST", { message });
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export const PRODUCT_FOR_UPLOAD_QUERY = /* GraphQL */ `
  query ProductForUpload($id: ID!) {
    product(id: $id) {
      id
      title
      status
      mediaCount {
        count
        precision
      }
    }
  }
`;

export const PRODUCT_MEDIA_IDS_QUERY = /* GraphQL */ `
  query ProductMediaIds($id: ID!, $after: String) {
    product(id: $id) {
      id
      media(first: 250, after: $after, query: "media_type:IMAGE", sortKey: POSITION) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const STAGED_UPLOADS_CREATE_MUTATION = /* GraphQL */ `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const FILE_CREATE_MUTATION = /* GraphQL */ `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const FILE_STATUS_QUERY = /* GraphQL */ `
  query FileStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        fileStatus
        fileErrors {
          code
        }
      }
    }
  }
`;

export const FILE_UPDATE_MUTATION = /* GraphQL */ `
  mutation AttachFileToProduct($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/;
export const MEDIA_IMAGE_GID_RE = /^gid:\/\/shopify\/MediaImage\/[1-9][0-9]{0,19}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_ALT_LENGTH = 512;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type ProductForUpload = { id: string; title: string; status: string; mediaCount: number | null };

/** Step 1 — the product must exist in the connected shop (the token is shop-scoped). */
export async function getProductForUpload(client: ShopifyAdminClient, productId: string): Promise<ProductForUpload> {
  if (!PRODUCT_GID_RE.test(productId)) throw new ShopifyUploadError("PRODUCT_NOT_FOUND");
  const { data } = await client.graphql<{
    product: { id: string; title: string; status: string; mediaCount: { count: number; precision: string } | null } | null;
  }>(PRODUCT_FOR_UPLOAD_QUERY, { id: productId });
  const p = data.product;
  if (!p || p.id !== productId) throw new ShopifyUploadError("PRODUCT_NOT_FOUND");
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    mediaCount: p.mediaCount && p.mediaCount.precision === "EXACT" ? p.mediaCount.count : null,
  };
}


/**
 * Returns the MediaImage IDs currently attached to a Shopify product.
 * This is intentionally read-only and paginated. The sync worker uses it once
 * per matched product to reconcile its upload ledger with Shopify's live state.
 */
export async function getAttachedProductMediaIds(
  input: { workspaceId: string; storeId: string; productId: string },
  deps: ConnectionDeps,
): Promise<Set<string>> {
  if (!PRODUCT_GID_RE.test(input.productId)) throw new ShopifyUploadError("PRODUCT_NOT_FOUND");

  const access = await refreshTokenIfNeeded(input.storeId, deps);
  if (access.credentials.workspaceId !== input.workspaceId) throw new ShopifyUploadError("STORE_NOT_FOUND");
  if (access.credentials.connectionStatus !== "connected") throw new ShopifyUploadError("SHOPIFY_NEEDS_RECONNECT");

  const client = createShopifyClient({
    shop: access.shop,
    accessToken: access.accessToken,
    apiVersion: deps.config.apiVersion,
    fetch: deps.fetch,
  });

  type ProductMediaIdsData = {
    product: {
      id: string;
      media: {
        nodes: { id: string }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
  type ProductMediaIdsVariables = { id: string; after: string | null };

  const ids = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const response: { data: ProductMediaIdsData } = await client.graphql<
      ProductMediaIdsData,
      ProductMediaIdsVariables
    >(PRODUCT_MEDIA_IDS_QUERY, { id: input.productId, after });

    const product: NonNullable<ProductMediaIdsData["product"]> | null =
      response.data.product;
    if (!product || product.id !== input.productId) throw new ShopifyUploadError("PRODUCT_NOT_FOUND");
    for (const media of product.media.nodes ?? []) {
      if (MEDIA_IMAGE_GID_RE.test(media.id)) ids.add(media.id);
    }
    if (!product.media.pageInfo.hasNextPage) return ids;
    after = product.media.pageInfo.endCursor;
    if (!after) throw new ShopifyUploadError("INVALID_REQUEST");
  }
}

/** Secret: never log, store or return outside this module. */
export type StagedTarget = { url: string; resourceUrl: string; parameters: { name: string; value: string }[] };

/** Step 2 — stagedUploadsCreate with resource IMAGE and httpMethod POST. */
export async function createStagedUpload(
  client: ShopifyAdminClient,
  input: { filename: string; mimeType: string; fileSize: number },
): Promise<StagedTarget> {
  const { data } = await client.graphql<{
    stagedUploadsCreate: { stagedTargets: StagedTarget[] | null; userErrors: UserError[] } | null;
  }>(STAGED_UPLOADS_CREATE_MUTATION, {
    input: [
      {
        resource: "IMAGE",
        filename: input.filename,
        mimeType: input.mimeType,
        httpMethod: "POST",
        fileSize: String(input.fileSize),
      },
    ],
  });
  const payload = data.stagedUploadsCreate;
  if (!payload) throw new ShopifyUploadError("INVALID_REQUEST");
  if (payload.userErrors.length) throw classifyUserErrors("staged", payload.userErrors);
  const target = payload.stagedTargets?.[0];
  let url: URL | null = null;
  try {
    url = target ? new URL(target.url) : null;
  } catch {
    url = null;
  }
  if (!target || !url || url.protocol !== "https:" || !target.resourceUrl || !Array.isArray(target.parameters)) {
    throw new ShopifyUploadError("STAGED_UPLOAD_FAILED", { message: "Shopify returned an incomplete upload target." });
  }
  return target;
}

/**
 * Step 3 — multipart POST to the staged target: every staged parameter first,
 * then the file. Sends NO Shopify access token and no other credentials.
 */
export async function postToStagedTarget(
  target: StagedTarget,
  file: { bytes: Uint8Array; filename: string; mimeType: string },
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([file.bytes as BlobPart], { type: file.mimeType }), file.filename);

  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target.url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ShopifyUploadError(timeout ? "STAGED_UPLOAD_TIMEOUT" : "STAGED_UPLOAD_FAILED");
  }
  if (res.ok) return;

  // Response bodies may echo the signed policy: read only to classify, never keep or log.
  const body = await res.text().catch(() => "");
  if (res.status === 413 || /EntityTooLarge/i.test(body)) throw new ShopifyUploadError("IMAGE_TOO_LARGE");
  const retryAfter = Number(res.headers.get("Retry-After"));
  if (res.status === 429 || res.status >= 500 || res.status === 403 || res.status === 408) {
    // 403 = expired/invalid signed policy → a new attempt stages a fresh target.
    throw new ShopifyUploadError("STAGED_UPLOAD_FAILED", {
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }
  throw new ShopifyUploadError("INVALID_REQUEST", { message: "Shopify's upload storage rejected the file." });
}

/** Step 4 — fileCreate from the staged resourceUrl. Returns the MediaImage ID. */
export async function createFile(
  client: ShopifyAdminClient,
  input: { resourceUrl: string; filename: string; altText?: string | null },
): Promise<{ mediaId: string; fileStatus: string | null }> {
  const alt = input.altText?.trim().slice(0, MAX_ALT_LENGTH) || undefined;
  const { data } = await client.graphql<{
    fileCreate: { files: { id: string; fileStatus: string | null }[] | null; userErrors: UserError[] } | null;
  }>(FILE_CREATE_MUTATION, {
    files: [
      {
        originalSource: input.resourceUrl,
        contentType: "IMAGE",
        filename: input.filename,
        ...(alt ? { alt } : {}),
        duplicateResolutionMode: "APPEND_UUID",
      },
    ],
  });
  const payload = data.fileCreate;
  if (!payload) throw new ShopifyUploadError("INVALID_REQUEST");
  if (payload.userErrors.length) throw classifyUserErrors("fileCreate", payload.userErrors);
  const file = payload.files?.[0];
  if (!file || !MEDIA_IMAGE_GID_RE.test(file.id)) {
    throw new ShopifyUploadError("INVALID_IMAGE", { message: "Shopify didn't create an image from this file." });
  }
  return { mediaId: file.id, fileStatus: file.fileStatus ?? null };
}

export type PollOptions = { maxPolls?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
export const DEFAULT_POLL = { maxPolls: 10, intervalMs: 2_000 } as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Step 5 — bounded polling of node(id) { fileStatus }.
 * READY → returns · FAILED → permanent IMAGE_PROCESSING_FAILED ·
 * still UPLOADED/PROCESSING after maxPolls → retryable MEDIA_PROCESSING_TIMEOUT
 * (the next attempt resumes THIS media; it never uploads again).
 */
export async function waitForFileReady(client: ShopifyAdminClient, mediaId: string, opts: PollOptions = {}): Promise<void> {
  const maxPolls = Math.max(1, opts.maxPolls ?? DEFAULT_POLL.maxPolls);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL.intervalMs;
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await sleep(intervalMs);
    const { data } = await client.graphql<{
      node: { id?: string; fileStatus?: string; fileErrors?: { code: string }[] } | null;
    }>(FILE_STATUS_QUERY, { id: mediaId });
    const node = data.node;
    if (!node || node.id !== mediaId) {
      throw new ShopifyUploadError("IMAGE_PROCESSING_FAILED", { message: "The uploaded image no longer exists in Shopify." });
    }
    if (node.fileStatus === "READY") return;
    if (node.fileStatus === "FAILED") {
      const codes = (node.fileErrors ?? []).map((e) => e.code).filter((c) => /^[A-Z_]{1,60}$/.test(c));
      throw new ShopifyUploadError("IMAGE_PROCESSING_FAILED", {
        message: codes.length ? `Shopify couldn't process this image (${codes.join(", ")}).` : undefined,
      });
    }
  }
  throw new ShopifyUploadError("MEDIA_PROCESSING_TIMEOUT");
}

/** Step 6 — fileUpdate referencesToAdd: attaches the media to the product. Changes nothing else. */
export async function attachFileToProduct(client: ShopifyAdminClient, mediaId: string, productId: string): Promise<void> {
  if (!MEDIA_IMAGE_GID_RE.test(mediaId)) throw new ShopifyUploadError("INVALID_REQUEST");
  if (!PRODUCT_GID_RE.test(productId)) throw new ShopifyUploadError("PRODUCT_NOT_FOUND");
  const { data } = await client.graphql<{
    fileUpdate: { files: { id: string }[] | null; userErrors: UserError[] } | null;
  }>(FILE_UPDATE_MUTATION, { files: [{ id: mediaId, referencesToAdd: [productId] }] });
  const payload = data.fileUpdate;
  if (!payload) throw new ShopifyUploadError("INVALID_REQUEST");
  if (payload.userErrors.length) throw classifyUserErrors("fileUpdate", payload.userErrors);
  if (!payload.files?.some((f) => f.id === mediaId)) throw new ShopifyUploadError("INVALID_REQUEST");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type UploadProductImageInput = {
  /** Resolved server-side from the sync job (never from a browser or n8n body). */
  workspaceId: string;
  storeId: string;
  syncItemId?: string | null;
  /** gid://shopify/Product/<id> */
  shopifyProductId: string;
  driveFileId: string;
  driveFolderId?: string | null;
  filename: string;
  mimeType: string;
  /** Image bytes loaded by trusted server code (the future Drive loader). */
  bytes: Uint8Array;
  altText?: string | null;
  checksum?: string | null;
  driveModifiedAt?: Date | null;
  dryRun?: boolean;
};

export type UploadProductImageResult =
  | { status: "uploaded"; productId: string; mediaId: string }
  | {
      status: "skipped";
      productId: string;
      mediaId: string | null;
      reason: "already_uploaded" | "in_progress" | "permanent_failure";
      errorCode?: string | null;
    }
  | { status: "dry_run"; productId: string; wouldUpload: true }
  | {
      status: "failed";
      productId: string;
      mediaId: string | null;
      error: { code: UploadErrorCode; message: string; retryable: boolean; retryAfterSeconds?: number };
    };

export type MediaDeps = ConnectionDeps & {
  images: SyncImageRepository;
  poll?: PollOptions;
  stagedUploadTimeoutMs?: number;
};

function failed(
  productId: string,
  mediaId: string | null,
  e: ShopifyUploadError,
): Extract<UploadProductImageResult, { status: "failed" }> {
  return {
    status: "failed",
    productId,
    mediaId,
    error: {
      code: e.code,
      message: e.publicMessage,
      retryable: e.retryable,
      ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
    },
  };
}

/** Token + client for the store, after checking the connection belongs to the workspace and is usable. */
async function connectedClient(input: UploadProductImageInput, deps: MediaDeps) {
  const access = await refreshTokenIfNeeded(input.storeId, deps);
  if (access.credentials.workspaceId !== input.workspaceId) throw new ShopifyUploadError("STORE_NOT_FOUND");
  if (access.credentials.connectionStatus !== "connected") throw new ShopifyUploadError("SHOPIFY_NEEDS_RECONNECT");
  return createShopifyClient({
    shop: access.shop,
    accessToken: access.accessToken,
    apiVersion: deps.config.apiVersion,
    fetch: deps.fetch,
  });
}

/** 401 / shop gone during an upload: same handling as Verify / product search. */
async function markNeedsReconnect(storeId: string, deps: MediaDeps, error: unknown) {
  if (error instanceof ShopifyApiError && (error.kind === "not_found" || (error.kind === "unauthorized" && error.status !== 403))) {
    await deps.repo
      .recordVerification({ storeId, ok: false, failureStatus: "needs_reconnect", error: error.userMessage })
      .catch(() => undefined);
  }
}

/**
 * Uploads ONE image to ONE existing Shopify product, with duplicate protection
 * through sync_images. Never throws for upload problems: returns a safe result.
 * Throws only if the ledger itself can't be read/written (caller retries the job).
 */
export async function uploadProductImage(input: UploadProductImageInput, deps: MediaDeps): Promise<UploadProductImageResult> {
  const productId = input.shopifyProductId;

  // --- input sanity (no I/O) --------------------------------------------------
  if (!UUID_RE.test(input.workspaceId) || !UUID_RE.test(input.storeId) || (input.syncItemId && !UUID_RE.test(input.syncItemId))) {
    return failed(productId, null, new ShopifyUploadError("STORE_NOT_FOUND"));
  }
  if (!PRODUCT_GID_RE.test(productId)) return failed(productId, null, new ShopifyUploadError("PRODUCT_NOT_FOUND"));
  if (!DRIVE_ID_RE.test(input.driveFileId) || (input.driveFolderId && !DRIVE_ID_RE.test(input.driveFolderId))) {
    return failed(productId, null, new ShopifyUploadError("INVALID_REQUEST", { message: "Invalid Drive file reference." }));
  }
  const filename = input.filename.trim();
  if (!filename || filename.length > 255 || /[\\/\u0000-\u001f]/.test(filename)) {
    return failed(productId, null, new ShopifyUploadError("INVALID_REQUEST", { message: "Invalid image filename." }));
  }

  // --- dry run: validate + read-only product check, zero mutations, no ledger writes ---
  if (input.dryRun) {
    const check = validateImageForUpload({ filename, mimeType: input.mimeType, bytes: input.bytes });
    if (!check.ok) return failed(productId, null, new ShopifyUploadError(check.code, { message: check.message }));
    try {
      const client = await connectedClient(input, deps);
      await getProductForUpload(client, productId);
      return { status: "dry_run", productId, wouldUpload: true };
    } catch (error) {
      await markNeedsReconnect(input.storeId, deps, error);
      return failed(productId, null, classifyUploadError(error));
    }
  }

  // --- duplicate protection: claim (also verifies workspace → store → sync item) ---
  let claim: { action: string; image: SyncImageRecord };
  try {
    claim = await deps.images.claim({
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      syncItemId: input.syncItemId ?? null,
      shopifyProductId: productId,
      driveFileId: input.driveFileId,
      driveFolderId: input.driveFolderId ?? null,
      filename,
      checksum: input.checksum ?? null,
      driveModifiedAt: input.driveModifiedAt ?? null,
      mimeType: input.mimeType.trim().toLowerCase() || null,
      fileSize: input.bytes.byteLength || null,
    });
  } catch (error) {
    if (error instanceof SyncImageAccessError) return failed(productId, null, new ShopifyUploadError("STORE_NOT_FOUND"));
    throw error;
  }

  const image = claim.image;
  if (claim.action === "skip") return { status: "skipped", productId, mediaId: image.shopifyMediaId, reason: "already_uploaded" };
  if (claim.action === "busy") return { status: "skipped", productId, mediaId: image.shopifyMediaId, reason: "in_progress" };
  if (claim.action === "blocked") {
    return { status: "skipped", productId, mediaId: image.shopifyMediaId, reason: "permanent_failure", errorCode: image.errorCode };
  }

  const scope = { workspaceId: input.workspaceId, storeId: input.storeId, imageId: image.id };
  await deps.images.recordAttempt(scope);
  let mediaId: string | null = claim.action === "resume" ? image.shopifyMediaId : null;

  try {
    if (claim.action === "upload") {
      // Validate before any Shopify call.
      const check = validateImageForUpload({ filename, mimeType: input.mimeType, bytes: input.bytes });
      if (!check.ok) throw new ShopifyUploadError(check.code, { message: check.message });

      const client = await connectedClient(input, deps);
      await getProductForUpload(client, productId);
      const target = await createStagedUpload(client, { filename, mimeType: check.mimeType, fileSize: check.size });
      await postToStagedTarget(
        target,
        { bytes: input.bytes, filename, mimeType: check.mimeType },
        { fetch: deps.fetch, timeoutMs: deps.stagedUploadTimeoutMs },
      );
      const created = await createFile(client, { resourceUrl: target.resourceUrl, filename, altText: input.altText });
      mediaId = created.mediaId;
      // Persist immediately: from here on, retries resume this media instead of uploading again.
      await deps.images.markProcessing(scope, mediaId);
      await waitForFileReady(client, mediaId, deps.poll);
      await attachFileToProduct(client, mediaId, productId);
    } else {
      // resume: a media already exists for this file — never create another one.
      if (!mediaId) throw new ShopifyUploadError("INTERNAL_ERROR");
      const client = await connectedClient(input, deps);
      await getProductForUpload(client, productId);
      await waitForFileReady(client, mediaId, deps.poll);
      await attachFileToProduct(client, mediaId, productId);
    }

    await deps.images.markUploaded(scope, mediaId);
    return { status: "uploaded", productId, mediaId };
  } catch (error) {
    if (error instanceof SyncImageAccessError) return failed(productId, mediaId, new ShopifyUploadError("STORE_NOT_FOUND"));
    await markNeedsReconnect(input.storeId, deps, error);
    const e = classifyUploadError(error);
    if (!(error instanceof ShopifyUploadError || error instanceof ShopifyApiError || error instanceof ShopifyFlowError)) {
      // Unexpected: class name only, never the message (could contain request details).
      console.error(`[shopify-media] unexpected ${error instanceof Error ? error.name : "error"}`);
    }
    await deps.images.markFailed(scope, { code: e.code, message: e.publicMessage, retryable: e.retryable });
    return failed(productId, mediaId, e);
  }
}
