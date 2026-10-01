import "server-only";

import { DriveApiError, type DriveClient } from "@/lib/google/client";
import { getDriveClient, refreshGoogleToken } from "@/lib/google/connection";
import {
  assertRootAccessible,
  classifyDownloadError,
  DriveDownloadError,
  loadStoreDriveContext,
  type DriveDownloadDeps,
} from "@/lib/google/download";
import { escapeDriveQuery, FOLDER_MIME, isIgnoredFolder } from "@/lib/google/folders";
import { classifyMatches, type MatchStatus } from "@/lib/matching/product-match";
import { ShopifyApiError } from "@/lib/shopify/client";
import type { ConnectionDeps } from "@/lib/shopify/connection";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import { extensionOf, SUPPORTED_IMAGE_TYPES } from "@/lib/shopify/media-validation";
import { searchProducts as defaultSearchProducts, type ProductSearchResult } from "@/lib/shopify/products";

/**
 * READ-ONLY Drive scanner + Shopify matching (Prompt 12).
 *
 *   category root (connected by the user, e.g. "Sofa image")
 *     → code folders (direct sub-folders, e.g. SOF-001) — discovered, never matched
 *       → product folders (sub-folders of a code folder, e.g. Milano) — THE matching key
 *         → images directly inside the product folder (metadata only, no bytes)
 *
 * Shopify matching reuses searchProducts() (Prompt 5: normalized title CONTAINS the
 * product-folder name, all statuses, never SKU). 0 → no_product_found, 1 → single_match,
 * 2+ → multiple_matches (all candidates returned, none chosen).
 *
 * Nothing is written anywhere (Drive, Shopify, database). Drive is listed one folder
 * at a time with pagination and hard limits.
 */

export type ScanImage = {
  fileId: string;
  folderId: string;
  filename: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  md5Checksum: string | null;
};

export type ScanProduct = { id: string; title: string; handle: string; status: string };

export type ScanMatch =
  | { outcome: MatchStatus; products: ScanProduct[]; truncated: boolean }
  | { outcome: "search_failed"; products: []; error: { code: string; message: string; retryable: boolean } };

export type ScanItem = {
  category_root: { id: string; name: string };
  code_folder: { id: string; name: string };
  product_folder: { id: string; name: string };
  match: ScanMatch;
  images: ScanImage[];
  images_truncated: boolean;
  /** Sub-folders inside the product folder: reported, never treated as products. */
  nested_folders: { id: string; name: string }[];
};

export type ScanWarningType =
  | "category_root_inaccessible"
  | "images_in_category_root"
  | "code_folder_without_product_folders"
  | "images_in_code_folder"
  | "nested_folders_in_product_folder"
  | "limit_reached";

export type ScanWarning = {
  type: ScanWarningType;
  category_root_id: string;
  folder_id?: string;
  folder_name?: string;
  detail?: string;
};

export type ScanResult = {
  store_id: string;
  category_roots: { id: string; name: string; code_folders: number; product_folders: number; images: number; accessible: boolean }[];
  items: ScanItem[];
  warnings: ScanWarning[];
  stats: {
    code_folders: number;
    product_folders: number;
    images: number;
    ignored_folders: number;
    unsupported_files: number;
    drive_list_requests: number;
    shopify_searches: number;
  };
};

export type ScanLimits = {
  /** files.list pageSize (Drive max 1000). */
  pageSize: number;
  maxCodeFoldersPerRoot: number;
  maxProductFoldersPerCode: number;
  maxImagesPerProduct: number;
  maxProductFoldersTotal: number;
};

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  pageSize: 100,
  maxCodeFoldersPerRoot: 1000,
  maxProductFoldersPerCode: 50,
  maxImagesPerProduct: 500,
  maxProductFoldersTotal: 2000,
};

export type ScanDeps = {
  google: DriveDownloadDeps;
  shopify: ConnectionDeps;
  limits?: Partial<ScanLimits>;
  /** Injectable for tests; defaults to the Prompt 5 service. */
  searchProducts?: (input: { storeId: string; searchTerm: string }, deps: ConnectionDeps) => Promise<ProductSearchResult>;
};

const LIST_COMMON = { supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" } as const;

type DriveEntry = { id: string; name: string; mimeType?: string; size?: string; md5Checksum?: string; modifiedTime?: string };

/** One folder's direct children (folders or non-folder files), paginated, bounded. */
async function listChildren(
  drive: DriveClient,
  parentId: string,
  kind: "folders" | "files",
  limit: number,
  limits: ScanLimits,
  counter: { requests: number },
): Promise<{ entries: DriveEntry[]; truncated: boolean }> {
  const q = [
    `'${escapeDriveQuery(parentId)}' in parents`,
    kind === "folders" ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`,
    "trashed = false",
  ].join(" and ");
  const fields =
    kind === "folders"
      ? "nextPageToken,files(id,name)"
      : "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)";
  const entries: DriveEntry[] = [];
  let pageToken: string | undefined;
  do {
    counter.requests += 1;
    const res = await drive.get<{ files?: DriveEntry[]; nextPageToken?: string }>("files", {
      q,
      fields,
      orderBy: "name_natural",
      pageSize: String(limits.pageSize),
      ...LIST_COMMON,
      ...(pageToken ? { pageToken } : {}),
    });
    entries.push(...(res.files ?? []));
    pageToken = res.nextPageToken || undefined;
    if (entries.length >= limit) return { entries: entries.slice(0, limit), truncated: entries.length > limit || !!pageToken };
  } while (pageToken);
  return { entries, truncated: false };
}

function toProduct(p: { id: string; title: string; handle: string; status: string }): ScanProduct {
  return { id: p.id, title: p.title, handle: p.handle, status: p.status };
}

const normName = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Scans the store's connected category roots (all of them, or the given subset —
 * which must be connected roots; arbitrary folder IDs are refused).
 * `workspaceId` is the server-side context (job / session) and is only compared
 * with the store's own workspace.
 */
export async function scanCategoryRoots(
  input: { workspaceId: string; storeId: string; categoryRootIds?: string[] },
  deps: ScanDeps,
): Promise<ScanResult> {
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS, ...deps.limits };
  const search = deps.searchProducts ?? defaultSearchProducts;
  try {
    // workspace → store → Google connected → category roots (of the current account)
    const store = await loadStoreDriveContext(input, deps.google);
    const { credentials } = await refreshGoogleToken(input.storeId, deps.google);
    if (credentials.workspaceId !== store.workspaceId) throw new DriveDownloadError("STORE_NOT_FOUND");
    if (credentials.connectionStatus !== "connected") throw new DriveDownloadError("GOOGLE_DRIVE_NOT_CONNECTED");
    if (store.googleAccountId && credentials.googleAccountId !== store.googleAccountId) {
      throw new DriveDownloadError("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
    }

    let roots = store.roots;
    if (input.categoryRootIds) {
      const allowed = new Map(roots.map((r) => [r.id, r]));
      if (!input.categoryRootIds.length || input.categoryRootIds.some((id) => !allowed.has(id))) {
        throw new DriveDownloadError("CATEGORY_ROOT_NOT_CONNECTED");
      }
      roots = [...new Set(input.categoryRootIds)].map((id) => allowed.get(id)!);
    }

    const drive = await getDriveClient(input.storeId, deps.google);
    const allowedExt = store.allowedImageTypes.map((t) => t.toLowerCase());
    const counter = { requests: 0 };
    const result: ScanResult = {
      store_id: input.storeId,
      category_roots: [],
      items: [],
      warnings: [],
      stats: { code_folders: 0, product_folders: 0, images: 0, ignored_folders: 0, unsupported_files: 0, drive_list_requests: 0, shopify_searches: 0 },
    };
    const searchCache = new Map<string, ScanMatch>();

    const isSupported = (f: DriveEntry) => {
      const ext = extensionOf(f.name ?? "");
      const mime = (SUPPORTED_IMAGE_TYPES as Record<string, string>)[ext];
      return Boolean(mime && allowedExt.includes(ext) && (f.mimeType ?? "").toLowerCase() === mime);
    };

    const match = async (name: string): Promise<ScanMatch> => {
      const key = normName(name);
      const cached = searchCache.get(key);
      if (cached) return cached;
      let m: ScanMatch;
      try {
        result.stats.shopify_searches += 1;
        const found = await search({ storeId: input.storeId, searchTerm: name }, deps.shopify);
        const classified = classifyMatches(found.products);
        m = { outcome: classified.status, products: classified.matches.map(toProduct), truncated: found.truncated };
      } catch (error) {
        if (error instanceof ShopifyFlowError) {
          // Connection-level problem: every search would fail the same way.
          throw new DriveDownloadError(error.code === "not_configured" ? "INTERNAL_ERROR" : "SHOPIFY_NOT_CONNECTED");
        }
        const e =
          error instanceof ShopifyApiError
            ? { code: `SHOPIFY_${error.kind.toUpperCase()}`, message: error.userMessage, retryable: error.retryable }
            : { code: "SHOPIFY_SEARCH_FAILED", message: "The Shopify product search failed.", retryable: true };
        m = { outcome: "search_failed", products: [], error: e };
      }
      searchCache.set(key, m);
      return m;
    };

    for (const root of roots) {
      const summary = { id: root.id, name: root.name, code_folders: 0, product_folders: 0, images: 0, accessible: true };
      result.category_roots.push(summary);
      try {
        const live = await assertRootAccessible(drive, root.id);
        summary.name = live.name; // Drive's current name
      } catch (error) {
        if (error instanceof DriveDownloadError && error.code === "DRIVE_ROOT_INACCESSIBLE") {
          summary.accessible = false;
          result.warnings.push({ type: "category_root_inaccessible", category_root_id: root.id, folder_name: root.name });
          continue;
        }
        throw error;
      }

      const rootFiles = await listChildren(drive, root.id, "files", 50, limits, counter);
      if (rootFiles.entries.some(isSupported)) {
        result.warnings.push({ type: "images_in_category_root", category_root_id: root.id, detail: "Images directly in a category folder are not synced." });
      }

      const codes = await listChildren(drive, root.id, "folders", limits.maxCodeFoldersPerRoot, limits, counter);
      if (codes.truncated) {
        result.warnings.push({ type: "limit_reached", category_root_id: root.id, detail: `Only the first ${limits.maxCodeFoldersPerRoot} code folders were scanned.` });
      }

      for (const code of codes.entries) {
        if (isIgnoredFolder(code.name, store.ignoredFolders)) {
          result.stats.ignored_folders += 1;
          continue;
        }
        summary.code_folders += 1;
        result.stats.code_folders += 1;

        const products = await listChildren(drive, code.id, "folders", limits.maxProductFoldersPerCode, limits, counter);
        const productFolders = products.entries.filter((p) => {
          const ignored = isIgnoredFolder(p.name, store.ignoredFolders);
          if (ignored) result.stats.ignored_folders += 1;
          return !ignored;
        });
        if (products.truncated) {
          result.warnings.push({ type: "limit_reached", category_root_id: root.id, folder_id: code.id, folder_name: code.name, detail: `Only the first ${limits.maxProductFoldersPerCode} product folders were scanned.` });
        }
        if (!productFolders.length) {
          const codeFiles = await listChildren(drive, code.id, "files", 50, limits, counter);
          result.warnings.push({
            type: codeFiles.entries.some(isSupported) ? "images_in_code_folder" : "code_folder_without_product_folders",
            category_root_id: root.id,
            folder_id: code.id,
            folder_name: code.name,
          });
          continue;
        }

        for (const product of productFolders) {
          if (result.stats.product_folders >= limits.maxProductFoldersTotal) {
            result.warnings.push({ type: "limit_reached", category_root_id: root.id, detail: `Stopped after ${limits.maxProductFoldersTotal} product folders.` });
            break;
          }
          summary.product_folders += 1;
          result.stats.product_folders += 1;

          const files = await listChildren(drive, product.id, "files", limits.maxImagesPerProduct, limits, counter);
          const images: ScanImage[] = [];
          for (const f of files.entries) {
            if (!isSupported(f)) {
              result.stats.unsupported_files += 1;
              continue;
            }
            const size = f.size !== undefined ? Number(f.size) : null;
            images.push({
              fileId: f.id,
              folderId: product.id,
              filename: f.name,
              mimeType: (f.mimeType ?? "").toLowerCase(),
              size: size !== null && Number.isFinite(size) ? size : null,
              modifiedTime: f.modifiedTime ?? null,
              md5Checksum: f.md5Checksum?.toLowerCase() ?? null,
            });
          }
          summary.images += images.length;
          result.stats.images += images.length;

          const nested = await listChildren(drive, product.id, "folders", 20, limits, counter);
          const nestedFolders = nested.entries
            .filter((n) => !isIgnoredFolder(n.name, store.ignoredFolders))
            .map((n) => ({ id: n.id, name: n.name }));
          result.stats.ignored_folders += nested.entries.length - nestedFolders.length;
          if (nestedFolders.length) {
            result.warnings.push({
              type: "nested_folders_in_product_folder",
              category_root_id: root.id,
              folder_id: product.id,
              folder_name: product.name,
              detail: `${nestedFolders.length} sub-folder(s) are not scanned as products.`,
            });
          }

          // Matching key = the PRODUCT folder name only (never the code folder, root or filenames).
          result.items.push({
            category_root: { id: root.id, name: summary.name },
            code_folder: { id: code.id, name: code.name },
            product_folder: { id: product.id, name: product.name },
            match: await match(product.name),
            images,
            images_truncated: files.truncated,
            nested_folders: nestedFolders,
          });
        }
      }
    }
    result.stats.drive_list_requests = counter.requests;
    return result;
  } catch (error) {
    if (!(error instanceof DriveApiError || error instanceof DriveDownloadError || error instanceof ShopifyFlowError)) {
      console.error(`[drive-scan] unexpected ${error instanceof Error ? error.name : "error"}`);
    }
    throw classifyDownloadError(error);
  }
}
