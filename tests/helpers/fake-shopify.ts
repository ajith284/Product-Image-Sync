import { randomUUID } from "node:crypto";

import { vi } from "vitest";

import { encryptToken, tokenContext } from "@/lib/shopify/crypto";
import type { MediaDeps } from "@/lib/shopify/media";
import {
  SyncImageAccessError,
  type ClaimAction,
  type ClaimInput,
  type SyncImageRecord,
  type SyncImageRepository,
} from "@/lib/sync/images-repository";

import { config, fakeRepo, NOW, SHOP, STORE_ID, WORKSPACE_ID } from "./shopify-fakes";

export const ACCESS = "shpat_ACCESS_SECRET_MEDIA";
export const REFRESH = "shprt_REFRESH_SECRET_MEDIA";
export const NEW_ACCESS = "shpat_ACCESS_SECRET_REFRESHED";
export const PRODUCT = "gid://shopify/Product/7001";
export const OTHER_STORE_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
export const STAGED_URL = "https://shopify-staged-uploads.storage.googleapis.com/";
export const STAGED_PARAMS = [
  { name: "Content-Type", value: "image/png" },
  { name: "success_action_status", value: "201" },
  { name: "acl", value: "private" },
  { name: "key", value: "tmp/1/products/abc/image-01.png" },
  { name: "x-goog-credential", value: "SIGNED_CREDENTIAL_SECRET" },
  { name: "x-goog-signature", value: "SIGNED_SIGNATURE_SECRET" },
  { name: "policy", value: "SIGNED_POLICY_SECRET" },
];
export const RESOURCE_URL = "https://shopify-staged-uploads.storage.googleapis.com/tmp/1/products/abc/image-01.png";
export const MEDIA_ID = "gid://shopify/MediaImage/9001";

/** Minimal valid PNG header (IHDR) with the given size, padded to `bytes`. */
export function png(width = 800, height = 600, bytes = 64): Uint8Array {
  const b = new Uint8Array(Math.max(bytes, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

export function jpeg(width = 1200, height = 900): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00,
    0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

type Resp = { status: number; body?: unknown; headers?: Record<string, string> };
const resp = (r: Resp) =>
  new Response(r.body === undefined ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
    status: r.status,
    headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
  });

export type ShopifyCall = {
  kind: "graphql" | "staged" | "token";
  op?: string;
  url: string;
  token: string | null;
  headers: Record<string, string>;
  variables?: Record<string, unknown>;
  form?: [string, string][];
};

export type FakeShopifyOptions = {
  products?: string[];
  /** One response per staged POST; default 201. */
  staged?: Resp[];
  /** HTTP-level override per GraphQL operation (consumed in order). */
  graphqlHttp?: Partial<Record<string, Resp[]>>;
  fileCreateUserErrors?: { field?: string[]; message: string; code?: string }[];
  fileUpdateUserErrors?: { field?: string[]; message: string; code?: string }[];
  /** Current MediaImage IDs attached to each product. */
  productMediaIds?: Record<string, string[]>;
  /** Sequence of fileStatus values returned by node(id); the last one repeats. */
  fileStatuses?: string[];
  fileErrors?: { code: string }[];
  /** Token endpoint response for refresh (default: new access token). */
  refresh?: Resp;
};

export function fakeShopify(opts: FakeShopifyOptions = {}) {
  const calls: ShopifyCall[] = [];
  const products = new Set(opts.products ?? [PRODUCT]);
  const staged = [...(opts.staged ?? [])];
  const http = Object.fromEntries(Object.entries(opts.graphqlHttp ?? {}).map(([k, v]) => [k, [...(v ?? [])]]));
  const statuses = [...(opts.fileStatuses ?? ["READY"])];
  let created = 0;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const token = new Headers(init?.headers).get("X-Shopify-Access-Token");

    if (url === `https://${SHOP}/admin/oauth/access_token`) {
      calls.push({ kind: "token", url, token, headers });
      return resp(
        opts.refresh ?? {
          status: 200,
          body: {
            access_token: NEW_ACCESS,
            refresh_token: "shprt_REFRESHED",
            scope: "read_products,write_products,write_files",
            expires_in: 3600,
            refresh_token_expires_in: 7_776_000,
          },
        },
      );
    }

    if (url.startsWith(STAGED_URL)) {
      const form = init?.body as FormData;
      const entries: [string, string][] = [...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${v.size}>`]);
      calls.push({ kind: "staged", url, token, headers, form: entries });
      return resp(staged.shift() ?? { status: 201, body: "" });
    }

    if (url === `https://${SHOP}/admin/api/2026-07/graphql.json`) {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "unknown";
      calls.push({ kind: "graphql", op, url, token, headers, variables: body.variables });
      const override = http[op]?.shift();
      if (override) return resp(override);

      switch (op) {
        case "ProductForUpload": {
          const id = String(body.variables.id);
          return resp({
            status: 200,
            body: {
              data: {
                product: products.has(id)
                  ? { id, title: "Milano 3 Seater Sofa", status: "DRAFT", mediaCount: { count: 2, precision: "EXACT" } }
                  : null,
              },
            },
          });
        }
        case "ProductMediaIds": {
          const id = String(body.variables.id);
          const ids = opts.productMediaIds?.[id] ?? [];
          return resp({
            status: 200,
            body: {
              data: {
                product: products.has(id)
                  ? {
                      id,
                      media: {
                        nodes: ids.map((mediaId) => ({ id: mediaId })),
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    }
                  : null,
              },
            },
          });
        }
        case "StagedUploadsCreate":
          return resp({
            status: 200,
            body: {
              data: {
                stagedUploadsCreate: {
                  stagedTargets: [{ url: STAGED_URL, resourceUrl: RESOURCE_URL, parameters: STAGED_PARAMS }],
                  userErrors: [],
                },
              },
            },
          });
        case "FileCreate": {
          if (opts.fileCreateUserErrors?.length) {
            return resp({ status: 200, body: { data: { fileCreate: { files: [], userErrors: opts.fileCreateUserErrors } } } });
          }
          created += 1;
          const id = created === 1 ? MEDIA_ID : `gid://shopify/MediaImage/${9000 + created}`;
          return resp({ status: 200, body: { data: { fileCreate: { files: [{ id, fileStatus: "UPLOADED" }], userErrors: [] } } } });
        }
        case "FileStatus": {
          const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
          return resp({
            status: 200,
            body: { data: { node: { id: body.variables.id, fileStatus: status, fileErrors: status === "FAILED" ? opts.fileErrors ?? [] : [] } } },
          });
        }
        case "AttachFileToProduct": {
          if (opts.fileUpdateUserErrors?.length) {
            return resp({ status: 200, body: { data: { fileUpdate: { files: [], userErrors: opts.fileUpdateUserErrors } } } });
          }
          const files = (body.variables.files as { id: string }[]).map((f) => ({ id: f.id, fileStatus: "READY" }));
          return resp({ status: 200, body: { data: { fileUpdate: { files, userErrors: [] } } } });
        }
      }
      return resp({ status: 200, body: { errors: [{ message: `unexpected ${op}` }] } });
    }
    throw new Error(`unexpected request to ${url}`);
  });

  const mutations = () =>
    calls.filter((c) => c.kind === "staged" || ["StagedUploadsCreate", "FileCreate", "AttachFileToProduct"].includes(c.op ?? ""));
  return { fetch: fetchImpl as unknown as typeof fetch, calls, mutations, ops: () => calls.map((c) => c.op ?? c.kind) };
}

// ---------------------------------------------------------------------------
// In-memory sync_images ledger mirroring the SQL sync_image_* functions.
// ---------------------------------------------------------------------------

type Row = SyncImageRecord & { workspaceId: string; checksum: string | null; modified: number | null; lastAttemptAt: number | null; errorMessage: string | null };

export function fakeImages(opts: { leaseMs?: number; maxAttempts?: number; now?: () => number } = {}) {
  const stores = new Map<string, string>([
    [STORE_ID, WORKSPACE_ID],
    [OTHER_STORE_ID, OTHER_WORKSPACE_ID],
  ]);
  const rows: Row[] = [];
  const now = opts.now ?? (() => NOW);
  const lease = opts.leaseMs ?? 15 * 60_000;
  const maxAttempts = opts.maxAttempts ?? 5;

  const checkStore = (ws: string, store: string) => {
    if (stores.get(store) !== ws) throw new SyncImageAccessError("store_not_found");
  };
  const find = (s: { workspaceId: string; storeId: string; imageId: string }) => {
    checkStore(s.workspaceId, s.storeId);
    const row = rows.find((r) => r.id === s.imageId && r.storeId === s.storeId);
    if (!row) throw new SyncImageAccessError("image_not_found");
    return row;
  };
  const view = (r: Row): SyncImageRecord => ({
    id: r.id,
    storeId: r.storeId,
    shopifyProductId: r.shopifyProductId,
    driveFileId: r.driveFileId,
    shopifyMediaId: r.shopifyMediaId,
    uploadStatus: r.uploadStatus,
    errorCode: r.errorCode,
    retryable: r.retryable,
    attemptCount: r.attemptCount,
  });

  const repo: SyncImageRepository = {
    claim: vi.fn(async (i: ClaimInput) => {
      checkStore(i.workspaceId, i.storeId);
      let row = rows.find((r) => r.storeId === i.storeId && r.shopifyProductId === i.shopifyProductId && r.driveFileId === i.driveFileId);
      const modified = i.driveModifiedAt ? i.driveModifiedAt.getTime() : null;
      if (!row) {
        row = {
          id: randomUUID(),
          workspaceId: i.workspaceId,
          storeId: i.storeId,
          shopifyProductId: i.shopifyProductId,
          driveFileId: i.driveFileId,
          shopifyMediaId: null,
          uploadStatus: "pending",
          errorCode: null,
          errorMessage: null,
          retryable: null,
          attemptCount: 0,
          checksum: i.checksum,
          modified,
          lastAttemptAt: now(),
        };
        rows.push(row);
        return { action: "upload" as ClaimAction, image: view(row) };
      }
      const changed =
        i.checksum && row.checksum ? i.checksum !== row.checksum : modified !== null && row.modified !== null ? modified !== row.modified : false;
      let action: ClaimAction;
      if (row.uploadStatus === "uploaded" && !changed) action = "skip";
      else if (row.uploadStatus === "processing") action = "resume";
      else if (row.uploadStatus === "pending" && row.lastAttemptAt !== null && row.lastAttemptAt > now() - lease) action = "busy";
      else if (row.uploadStatus === "failed" && !changed && (!row.retryable || row.attemptCount >= maxAttempts)) action = "blocked";
      else if (row.uploadStatus === "failed" && !changed && row.shopifyMediaId) action = "resume";
      else action = "upload";
      if (action === "upload" || action === "resume") {
        row.checksum = i.checksum ?? row.checksum;
        row.modified = modified ?? row.modified;
        if (action === "upload") row.shopifyMediaId = null;
        row.uploadStatus = action === "upload" ? "pending" : "processing";
        if (changed) row.attemptCount = 0;
        row.lastAttemptAt = now();
      }
      return { action, image: view(row) };
    }),
    recordAttempt: vi.fn(async (s) => {
      const row = find(s);
      row.attemptCount += 1;
      row.lastAttemptAt = now();
      return view(row);
    }),
    markProcessing: vi.fn(async (s, mediaId) => {
      const row = find(s);
      if (row.shopifyMediaId && row.shopifyMediaId !== mediaId) throw new SyncImageAccessError("image_not_found");
      Object.assign(row, { uploadStatus: "processing", shopifyMediaId: mediaId, errorCode: null, errorMessage: null, retryable: null });
      return view(row);
    }),
    markUploaded: vi.fn(async (s, mediaId) => {
      const row = find(s);
      if (row.shopifyMediaId !== mediaId) throw new SyncImageAccessError("image_not_found");
      Object.assign(row, { uploadStatus: "uploaded", errorCode: null, errorMessage: null, retryable: null });
      return view(row);
    }),
    resetMissing: vi.fn(async (i) => {
      checkStore(i.workspaceId, i.storeId);
      const row = rows.find(
        (r) =>
          r.storeId === i.storeId &&
          r.shopifyProductId === i.shopifyProductId &&
          r.driveFileId === i.driveFileId,
      );
      if (!row) throw new SyncImageAccessError("image_not_found");
      Object.assign(row, {
        uploadStatus: "pending",
        shopifyMediaId: null,
        attemptCount: 0,
        lastAttemptAt: null,
        errorCode: null,
        errorMessage: null,
        retryable: null,
      });
      return view(row);
    }),
    markFailed: vi.fn(async (s, e) => {
      const row = find(s);
      if (row.uploadStatus === "uploaded") throw new SyncImageAccessError("image_not_found");
      Object.assign(row, { uploadStatus: "failed", errorCode: e.code, errorMessage: e.message, retryable: e.retryable });
      return view(row);
    }),
  };
  return { repo, rows };
}

/** Connection deps with an encrypted, still-valid token (or expiring, for refresh tests). */
export function mediaDeps(
  fetchImpl: typeof fetch,
  images: SyncImageRepository,
  opts: { expiresInMs?: number; connectionStatus?: string; workspaceId?: string } = {},
): MediaDeps & { state: ReturnType<typeof fakeRepo>["state"] } {
  const { repo, state } = fakeRepo();
  state.creds = {
    connectionId: "conn-1",
    workspaceId: opts.workspaceId ?? WORKSPACE_ID,
    shopDomain: SHOP,
    connectionStatus: opts.connectionStatus ?? "connected",
    encryptedAccessToken: encryptToken(ACCESS, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "access")),
    encryptedRefreshToken: encryptToken(REFRESH, config.tokenEncryptionKey, tokenContext(STORE_ID, SHOP, "refresh")),
    tokenExpiresAt: new Date(NOW + (opts.expiresInMs ?? 3_600_000)),
    refreshTokenExpiresAt: new Date(NOW + 86_400_000),
    tokenVersion: 1,
  };
  return {
    config,
    repo,
    state,
    images,
    fetch: fetchImpl,
    now: () => NOW,
    poll: { maxPolls: 3, intervalMs: 0, sleep: async () => undefined },
  };
}
