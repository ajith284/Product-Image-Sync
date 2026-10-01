import { describe, expect, it } from "vitest";

import { createShopifyClient, ShopifyApiError } from "@/lib/shopify/client";
import { ShopifyFlowError } from "@/lib/shopify/errors";
import {
  attachFileToProduct,
  classifyUploadError,
  createFile,
  createStagedUpload,
  getProductForUpload,
  postToStagedTarget,
  ShopifyUploadError,
  uploadProductImage,
  waitForFileReady,
  type UploadProductImageInput,
} from "@/lib/shopify/media";
import { inspectImage, MAX_IMAGE_BYTES, validateImageForUpload } from "@/lib/shopify/media-validation";
import { SyncImageAccessError } from "@/lib/sync/images-repository";
import {
  ACCESS,
  fakeImages,
  fakeShopify,
  jpeg,
  MEDIA_ID,
  mediaDeps,
  NEW_ACCESS,
  OTHER_STORE_ID,
  OTHER_WORKSPACE_ID,
  png,
  PRODUCT,
  REFRESH,
  RESOURCE_URL,
  STAGED_PARAMS,
  STAGED_URL,
} from "./helpers/fake-shopify";
import { SHOP, STORE_ID, WORKSPACE_ID } from "./helpers/shopify-fakes";

const FILE = "1AbCdEfGhIjKlMnOp";
const input = (over: Partial<UploadProductImageInput> = {}): UploadProductImageInput => ({
  workspaceId: WORKSPACE_ID,
  storeId: STORE_ID,
  shopifyProductId: PRODUCT,
  driveFileId: FILE,
  driveFolderId: "folderMilano01",
  filename: "image-01.png",
  mimeType: "image/png",
  bytes: png(),
  altText: "Milano sofa front view",
  checksum: "md5-v1",
  driveModifiedAt: new Date("2026-09-30T10:00:00Z"),
  ...over,
});

function setup(shopifyOpts: Parameters<typeof fakeShopify>[0] = {}, depsOpts: Parameters<typeof mediaDeps>[2] = {}) {
  const shop = fakeShopify(shopifyOpts);
  const images = fakeImages();
  const deps = mediaDeps(shop.fetch, images.repo, depsOpts);
  return { shop, images, deps };
}

const client = (fetchImpl: typeof fetch) =>
  createShopifyClient({ shop: SHOP, accessToken: ACCESS, apiVersion: "2026-07", fetch: fetchImpl });

/** Nothing secret may ever appear in a result, DB write or logged error. */
function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of [ACCESS, REFRESH, NEW_ACCESS, "SIGNED_", STAGED_URL, RESOURCE_URL, "test-client-secret"]) {
    expect(text).not.toContain(secret);
  }
}

describe("getProductForUpload", () => {
  it("1. returns a product that exists in the connected shop", async () => {
    const { shop } = setup();
    const p = await getProductForUpload(client(shop.fetch), PRODUCT);
    expect(p).toEqual({ id: PRODUCT, title: "Milano 3 Seater Sofa", status: "DRAFT", mediaCount: 2 });
    expect(shop.calls[0]!.variables).toEqual({ id: PRODUCT });
  });

  it("2. product not found → PRODUCT_NOT_FOUND and nothing is uploaded", async () => {
    const { shop, deps } = setup({ products: [] });
    const r = await uploadProductImage(input(), deps);
    expect(r).toMatchObject({ status: "failed", error: { code: "PRODUCT_NOT_FOUND", retryable: false } });
    expect(shop.mutations()).toHaveLength(0);
  });

  it("3. invalid product GID → PRODUCT_NOT_FOUND without calling Shopify", async () => {
    const { shop, deps } = setup();
    for (const bad of ["7001", "gid://shopify/ProductVariant/7001", "gid://shopify/Product/abc", "gid://shopify/Product/0"]) {
      await expect(getProductForUpload(client(shop.fetch), bad)).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
      const r = await uploadProductImage(input({ shopifyProductId: bad }), deps);
      expect(r).toMatchObject({ status: "failed", error: { code: "PRODUCT_NOT_FOUND" } });
    }
    expect(shop.calls).toHaveLength(0);
  });
});

describe("staged upload", () => {
  it("4. stagedUploadsCreate uses resource IMAGE + POST, then posts parameters first and the file last, without the Shopify token", async () => {
    const { shop } = setup();
    const c = client(shop.fetch);
    const target = await createStagedUpload(c, { filename: "image-01.png", mimeType: "image/png", fileSize: 64 });
    expect(shop.calls[0]!.variables).toEqual({
      input: [{ resource: "IMAGE", filename: "image-01.png", mimeType: "image/png", httpMethod: "POST", fileSize: "64" }],
    });
    expect(JSON.stringify(shop.calls[0]!.variables)).not.toContain("PRODUCT_IMAGE");

    await postToStagedTarget(target, { bytes: png(), filename: "image-01.png", mimeType: "image/png" }, { fetch: shop.fetch });
    const post = shop.calls.find((c) => c.kind === "staged")!;
    expect(post.form!.map(([k]) => k)).toEqual([...STAGED_PARAMS.map((p) => p.name), "file"]);
    expect(post.form!.at(-1)![1]).toBe("<file 64>");
    expect(post.token).toBeNull();
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).not.toContain("x-shopify-access-token");
  });

  it("5. staged upload 429 → retryable STAGED_UPLOAD_FAILED with Retry-After", async () => {
    const { shop, deps, images } = setup({ staged: [{ status: 429, body: "SlowDown", headers: { "Retry-After": "7" } }] });
    const r = await uploadProductImage(input(), deps);
    expect(r).toMatchObject({ status: "failed", error: { code: "STAGED_UPLOAD_FAILED", retryable: true, retryAfterSeconds: 7 } });
    expect(shop.ops()).not.toContain("FileCreate");
    expect(images.rows[0]).toMatchObject({ uploadStatus: "failed", retryable: true, shopifyMediaId: null });
  });

  it("6. staged upload 5xx and timeout → retryable", async () => {
    const { deps } = setup({ staged: [{ status: 503, body: "" }] });
    expect(await uploadProductImage(input(), deps)).toMatchObject({ error: { code: "STAGED_UPLOAD_FAILED", retryable: true } });

    const timeoutFetch = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const target = { url: STAGED_URL, resourceUrl: RESOURCE_URL, parameters: STAGED_PARAMS };
    await expect(
      postToStagedTarget(target, { bytes: png(), filename: "a.png", mimeType: "image/png" }, { fetch: timeoutFetch }),
    ).rejects.toMatchObject({ code: "STAGED_UPLOAD_TIMEOUT", retryable: true });
  });
});

describe("fileCreate / wait / attach", () => {
  it("7. fileCreate uses the staged resourceUrl, IMAGE, filename, alt, APPEND_UUID and returns the MediaImage id", async () => {
    const { shop } = setup();
    const r = await createFile(client(shop.fetch), { resourceUrl: RESOURCE_URL, filename: "image-01.png", altText: "Front" });
    expect(r.mediaId).toBe(MEDIA_ID);
    expect(shop.calls[0]!.variables).toEqual({
      files: [{ originalSource: RESOURCE_URL, contentType: "IMAGE", filename: "image-01.png", alt: "Front", duplicateResolutionMode: "APPEND_UUID" }],
    });
  });

  it("8. fileCreate userErrors → classified, media never marked processing", async () => {
    const { deps, images } = setup({ fileCreateUserErrors: [{ field: ["files", "0"], message: "Image is invalid", code: "UNACCEPTABLE_ASSET" }] });
    const r = await uploadProductImage(input(), deps);
    expect(r).toMatchObject({ status: "failed", mediaId: null, error: { code: "INVALID_IMAGE", retryable: false } });
    expect(images.repo.markProcessing).not.toHaveBeenCalled();
  });

  it("9. media READY → continues", async () => {
    const { shop } = setup({ fileStatuses: ["UPLOADED", "PROCESSING", "READY"] });
    await expect(waitForFileReady(client(shop.fetch), MEDIA_ID, { maxPolls: 5, sleep: async () => undefined })).resolves.toBeUndefined();
    expect(shop.ops().filter((o) => o === "FileStatus")).toHaveLength(3);
  });

  it("10. media still PROCESSING after bounded polling → retryable MEDIA_PROCESSING_TIMEOUT", async () => {
    const { shop } = setup({ fileStatuses: ["PROCESSING"] });
    await expect(waitForFileReady(client(shop.fetch), MEDIA_ID, { maxPolls: 4, sleep: async () => undefined })).rejects.toMatchObject({
      code: "MEDIA_PROCESSING_TIMEOUT",
      retryable: true,
    });
    expect(shop.ops().filter((o) => o === "FileStatus")).toHaveLength(4);
  });

  it("11. media FAILED → permanent IMAGE_PROCESSING_FAILED, not attached", async () => {
    const { shop, deps, images } = setup({ fileStatuses: ["FAILED"], fileErrors: [{ code: "MEDIA_ERROR_UNSUPPORTED" }] });
    const r = await uploadProductImage(input(), deps);
    expect(r).toMatchObject({ status: "failed", mediaId: MEDIA_ID, error: { code: "IMAGE_PROCESSING_FAILED", retryable: false } });
    expect(shop.ops()).not.toContain("AttachFileToProduct");
    expect(images.rows[0]).toMatchObject({ uploadStatus: "failed", retryable: false, shopifyMediaId: MEDIA_ID });
  });

  it("12. fileUpdate attaches with referencesToAdd only — no productUpdate / productCreateMedia", async () => {
    const { shop } = setup();
    await attachFileToProduct(client(shop.fetch), MEDIA_ID, PRODUCT);
    expect(shop.calls[0]!.variables).toEqual({ files: [{ id: MEDIA_ID, referencesToAdd: [PRODUCT] }] });
  });
});

describe("uploadProductImage", () => {
  it("successful upload runs the exact sequence and stores the media id", async () => {
    const { shop, deps, images } = setup();
    const r = await uploadProductImage(input(), deps);
    expect(r).toEqual({ status: "uploaded", productId: PRODUCT, mediaId: MEDIA_ID });
    expect(shop.ops()).toEqual(["ProductForUpload", "StagedUploadsCreate", "staged", "FileCreate", "FileStatus", "AttachFileToProduct"]);
    for (const c of shop.calls.filter((c) => c.kind === "graphql")) {
      expect(c.token).toBe(ACCESS);
      expect(c.variables && JSON.stringify(c.variables)).not.toMatch(/productUpdate|productCreateMedia|productSet/);
    }
    expect(images.repo.markProcessing).toHaveBeenCalledWith(expect.anything(), MEDIA_ID);
    expect(images.rows[0]).toMatchObject({ uploadStatus: "uploaded", shopifyMediaId: MEDIA_ID, attemptCount: 1, errorCode: null });
    expectNoSecrets(r);
  });

  it("13. refreshes an expiring token and uses the new one", async () => {
    const { shop, deps } = setup({}, { expiresInMs: 60_000 });
    const r = await uploadProductImage(input(), deps);
    expect(r.status).toBe("uploaded");
    expect(shop.calls[0]!.kind).toBe("token");
    expect(shop.calls.filter((c) => c.kind === "graphql").every((c) => c.token === NEW_ACCESS)).toBe(true);
    expectNoSecrets(r);
  });

  it("14. rejected refresh / 401 → SHOPIFY_NEEDS_RECONNECT and the store is marked needs_reconnect", async () => {
    const a = setup({ refresh: { status: 400, body: { error: "invalid_grant" } } }, { expiresInMs: 60_000 });
    const r1 = await uploadProductImage(input(), a.deps);
    expect(r1).toMatchObject({ status: "failed", error: { code: "SHOPIFY_NEEDS_RECONNECT", retryable: false } });
    expect(a.deps.state.verifications.at(-1)).toMatchObject({ ok: false, failureStatus: "needs_reconnect" });
    expect(a.shop.mutations()).toHaveLength(0);

    const b = setup({ graphqlHttp: { ProductForUpload: [{ status: 401, body: {} }] } });
    const r2 = await uploadProductImage(input(), b.deps);
    expect(r2).toMatchObject({ error: { code: "SHOPIFY_NEEDS_RECONNECT" } });
    expect(b.deps.state.verifications.at(-1)).toMatchObject({ failureStatus: "needs_reconnect" });

    const c = setup({}, { connectionStatus: "needs_reconnect" });
    expect(await uploadProductImage(input(), c.deps)).toMatchObject({ error: { code: "SHOPIFY_NEEDS_RECONNECT" } });
    expect(c.shop.calls).toHaveLength(0);
  });

  it("15. unsupported MIME / extension → UNSUPPORTED_MIME_TYPE before any Shopify call", async () => {
    const { shop, deps } = setup();
    for (const over of [
      { filename: "image.bmp", mimeType: "image/bmp" },
      { filename: "image.tiff", mimeType: "image/tiff" },
      { filename: "image.png", mimeType: "image/jpeg" },
      { filename: "image.svg", mimeType: "image/svg+xml" },
    ]) {
      const r = await uploadProductImage(input({ ...over, driveFileId: `f${over.filename.length}${over.mimeType.length}` }), deps);
      expect(r).toMatchObject({ status: "failed", error: { code: "UNSUPPORTED_MIME_TYPE", retryable: false } });
    }
    expect(shop.calls).toHaveLength(0);
  });

  it("16. image over 20 MB or over 4472 px → IMAGE_TOO_LARGE before any Shopify call", async () => {
    const { shop, deps } = setup();
    const big = await uploadProductImage(input({ bytes: png(800, 600, MAX_IMAGE_BYTES + 1), driveFileId: "fileBig" }), deps);
    expect(big).toMatchObject({ error: { code: "IMAGE_TOO_LARGE", retryable: false } });
    const wide = await uploadProductImage(input({ bytes: png(4473, 100), driveFileId: "fileWide" }), deps);
    expect(wide).toMatchObject({ error: { code: "IMAGE_TOO_LARGE" } });
    expect(shop.calls).toHaveLength(0);
  });

  it("17. already uploaded + unchanged → skipped, zero Shopify calls", async () => {
    const { shop, deps } = setup();
    expect((await uploadProductImage(input(), deps)).status).toBe("uploaded");
    const before = shop.calls.length;
    const again = await uploadProductImage(input({ filename: "renamed.png" }), deps);
    expect(again).toEqual({ status: "skipped", productId: PRODUCT, mediaId: MEDIA_ID, reason: "already_uploaded" });
    expect(shop.calls.length).toBe(before);

    const changed = await uploadProductImage(input({ checksum: "md5-v2" }), deps);
    expect(changed.status).toBe("uploaded");
    expect(shop.ops().filter((o) => o === "FileCreate")).toHaveLength(2);
  });

  it("18. a processing image is resumed — never a second fileCreate", async () => {
    const { shop, deps, images } = setup({ fileStatuses: ["PROCESSING", "PROCESSING", "PROCESSING", "READY"] });
    const first = await uploadProductImage(input(), deps);
    expect(first).toMatchObject({ status: "failed", mediaId: MEDIA_ID, error: { code: "MEDIA_PROCESSING_TIMEOUT", retryable: true } });

    const second = await uploadProductImage(input(), deps);
    expect(second).toEqual({ status: "uploaded", productId: PRODUCT, mediaId: MEDIA_ID });
    expect(shop.ops().filter((o) => o === "FileCreate")).toHaveLength(1);
    expect(shop.ops().filter((o) => o === "StagedUploadsCreate")).toHaveLength(1);
    expect(images.rows[0]).toMatchObject({ uploadStatus: "uploaded", attemptCount: 2 });

    // A row still in "processing" (e.g. a worker crashed) is also only resumed.
    images.rows[0]!.uploadStatus = "processing";
    images.rows[0]!.shopifyMediaId = MEDIA_ID;
    const third = await uploadProductImage(input(), deps);
    expect(third.status).toBe("uploaded");
    expect(shop.ops().filter((o) => o === "FileCreate")).toHaveLength(1);
  });

  it("19. retryable failure (429 / 5xx) → recorded as retryable and a later attempt uploads", async () => {
    const { shop, deps, images } = setup({
      graphqlHttp: { StagedUploadsCreate: [{ status: 429, body: {}, headers: { "Retry-After": "3" } }, { status: 502, body: {} }] },
    });
    const r1 = await uploadProductImage(input(), deps);
    expect(r1).toMatchObject({ error: { code: "SHOPIFY_THROTTLED", retryable: true, retryAfterSeconds: 3 } });
    expect(images.rows[0]).toMatchObject({ uploadStatus: "failed", retryable: true, errorCode: "SHOPIFY_THROTTLED" });
    const r2 = await uploadProductImage(input(), deps);
    expect(r2).toMatchObject({ error: { code: "SHOPIFY_UNAVAILABLE", retryable: true } });
    const r3 = await uploadProductImage(input(), deps);
    expect(r3.status).toBe("uploaded");
    expect(images.rows[0]).toMatchObject({ uploadStatus: "uploaded", errorCode: null, retryable: null, attemptCount: 3 });
    expect(shop.ops().filter((o) => o === "FileCreate")).toHaveLength(1);
  });

  it("20. permanent failure is not retried blindly — only when the Drive file changes", async () => {
    const { shop, deps } = setup({ products: [] });
    expect(await uploadProductImage(input(), deps)).toMatchObject({ error: { code: "PRODUCT_NOT_FOUND", retryable: false } });
    const before = shop.calls.length;
    const again = await uploadProductImage(input(), deps);
    expect(again).toMatchObject({ status: "skipped", reason: "permanent_failure", errorCode: "PRODUCT_NOT_FOUND" });
    expect(shop.calls.length).toBe(before);
    const changed = await uploadProductImage(input({ checksum: "md5-v2" }), deps);
    expect(changed.status).toBe("failed"); // tried again because the file changed
    expect(shop.calls.length).toBeGreaterThan(before);
  });

  it("21. wrong workspace / store → STORE_NOT_FOUND, nothing read or written in Shopify", async () => {
    const { shop, deps, images } = setup();
    const r1 = await uploadProductImage(input({ workspaceId: OTHER_WORKSPACE_ID }), deps);
    expect(r1).toMatchObject({ status: "failed", error: { code: "STORE_NOT_FOUND", retryable: false } });
    const r2 = await uploadProductImage(input({ storeId: OTHER_STORE_ID }), deps);
    expect(r2).toMatchObject({ error: { code: "STORE_NOT_FOUND" } });
    expect(shop.calls).toHaveLength(0);
    expect(images.rows).toHaveLength(0);

    // Connection belonging to another workspace (defence in depth) → refused before any upload.
    const other = setup({}, { workspaceId: OTHER_WORKSPACE_ID });
    expect(await uploadProductImage(input(), other.deps)).toMatchObject({ error: { code: "STORE_NOT_FOUND" } });
    expect(other.shop.calls.filter((c) => c.kind === "graphql")).toHaveLength(0);

    // Ledger refuses cross-store updates.
    await expect(
      images.repo.markFailed({ workspaceId: WORKSPACE_ID, storeId: OTHER_STORE_ID, imageId: "x" }, { code: "X_Y", message: "", retryable: true }),
    ).rejects.toBeInstanceOf(SyncImageAccessError);
  });

  it("22. dry run → zero Shopify mutations and no ledger writes", async () => {
    const { shop, deps, images } = setup();
    const r = await uploadProductImage(input({ dryRun: true }), deps);
    expect(r).toEqual({ status: "dry_run", productId: PRODUCT, wouldUpload: true });
    expect(shop.mutations()).toHaveLength(0);
    expect(shop.ops()).toEqual(["ProductForUpload"]);
    expect(images.repo.claim).not.toHaveBeenCalled();
    expect(images.rows).toHaveLength(0);

    const missing = await uploadProductImage(input({ dryRun: true, shopifyProductId: "gid://shopify/Product/404" }), deps);
    expect(missing).toMatchObject({ status: "failed", error: { code: "PRODUCT_NOT_FOUND" } });
    expect(shop.mutations()).toHaveLength(0);
  });

  it("never returns or stores tokens, staged URLs or staged parameters", async () => {
    const { deps, images } = setup({ staged: [{ status: 403, body: "<Error>SIGNED_POLICY_SECRET expired</Error>" }] });
    const r = await uploadProductImage(input(), deps);
    expect(r).toMatchObject({ error: { code: "STAGED_UPLOAD_FAILED", retryable: true } });
    expectNoSecrets(r);
    expectNoSecrets(images.rows);
    for (const call of (images.repo.markFailed as unknown as { mock: { calls: unknown[] } }).mock.calls) expectNoSecrets(call);
  });

  it("fileUpdate errors: product reference missing → PRODUCT_NOT_FOUND; not ready → retryable", async () => {
    const a = setup({ fileUpdateUserErrors: [{ message: "Product does not exist", code: "REFERENCE_TARGET_DOES_NOT_EXIST" }] });
    expect(await uploadProductImage(input(), a.deps)).toMatchObject({ error: { code: "PRODUCT_NOT_FOUND", retryable: false } });
    const b = setup({ fileUpdateUserErrors: [{ message: "File is still processing", code: "NON_READY_STATE" }] });
    expect(await uploadProductImage(input(), b.deps)).toMatchObject({ error: { code: "MEDIA_PROCESSING_TIMEOUT", retryable: true } });
  });
});

describe("classifyUploadError", () => {
  it("maps existing Shopify error kinds and flow errors", () => {
    expect(classifyUploadError(new ShopifyApiError("throttled", "x", { status: 429, retryAfterSeconds: 4 }))).toMatchObject({
      code: "SHOPIFY_THROTTLED",
      retryable: true,
      retryAfterSeconds: 4,
    });
    expect(classifyUploadError(new ShopifyApiError("unavailable", "x", { status: 503 }))).toMatchObject({ code: "SHOPIFY_UNAVAILABLE", retryable: true });
    expect(classifyUploadError(new ShopifyApiError("network", "x"))).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(classifyUploadError(new ShopifyApiError("unauthorized", "x", { status: 401 }))).toMatchObject({ code: "SHOPIFY_NEEDS_RECONNECT", retryable: false });
    expect(classifyUploadError(new ShopifyApiError("unauthorized", "x", { status: 403 }))).toMatchObject({ code: "SCOPE_OR_PERMISSION", retryable: false });
    expect(
      classifyUploadError(new ShopifyApiError("graphql", "x", { graphqlErrors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] })),
    ).toMatchObject({ code: "SCOPE_OR_PERMISSION" });
    expect(classifyUploadError(new ShopifyApiError("graphql", "x"))).toMatchObject({ code: "INVALID_REQUEST", retryable: false });
    expect(classifyUploadError(new ShopifyFlowError("verify_failed"))).toMatchObject({ code: "TOKEN_REFRESH_UNAVAILABLE", retryable: true });
    expect(classifyUploadError(new ShopifyFlowError("needs_reconnect"))).toMatchObject({ code: "SHOPIFY_NEEDS_RECONNECT", retryable: false });
    expect(classifyUploadError(new Error("boom"))).toMatchObject({ code: "INTERNAL_ERROR", retryable: true });
    expect(new ShopifyUploadError("INVALID_IMAGE").retryable).toBe(false);
  });

  it("temporary token refresh failure → retryable TOKEN_REFRESH_UNAVAILABLE", async () => {
    const { deps, shop } = setup({ refresh: { status: 503, body: {} } }, { expiresInMs: 60_000 });
    expect(await uploadProductImage(input(), deps)).toMatchObject({ error: { code: "TOKEN_REFRESH_UNAVAILABLE", retryable: true } });
    expect(shop.mutations()).toHaveLength(0);
  });
});

describe("image validation", () => {
  it("reads real dimensions from JPEG, PNG, GIF, WEBP and HEIC headers", () => {
    expect(inspectImage(jpeg(1200, 900))).toEqual({ mimeType: "image/jpeg", width: 1200, height: 900 });
    expect(inspectImage(png(640, 480))).toEqual({ mimeType: "image/png", width: 640, height: 480 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02, 0, 0, 0]);
    expect(inspectImage(gif)).toEqual({ mimeType: "image/gif", width: 800, height: 600 });
    const webp = new Uint8Array(40);
    webp.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8X")]);
    webp.set([0x1f, 0x03, 0x00, 0x57, 0x02, 0x00], 24); // 800 × 600 (stored minus one)
    expect(inspectImage(webp)).toEqual({ mimeType: "image/webp", width: 800, height: 600 });
    const heic = new Uint8Array(64);
    heic.set([0, 0, 0, 24, ...Buffer.from("ftypheic")]);
    heic.set([...Buffer.from("ispe"), 0, 0, 0, 0, 0, 0, 0x0f, 0xa0, 0, 0, 0x0b, 0xb8], 30); // 4000 × 3000
    expect(inspectImage(heic)).toEqual({ mimeType: "image/heic", width: 4000, height: 3000 });
  });

  it("rejects content that doesn't match its declared type, empty files and extreme ratios", () => {
    expect(validateImageForUpload({ filename: "a.jpg", mimeType: "image/jpeg", bytes: png() })).toMatchObject({ ok: false, code: "INVALID_IMAGE" });
    expect(validateImageForUpload({ filename: "a.png", mimeType: "image/png", bytes: new Uint8Array() })).toMatchObject({ ok: false, code: "INVALID_IMAGE" });
    expect(validateImageForUpload({ filename: "a.png", mimeType: "image/png", bytes: new Uint8Array(100) })).toMatchObject({ ok: false, code: "INVALID_IMAGE" });
    expect(validateImageForUpload({ filename: "a.png", mimeType: "image/png", bytes: png(4000, 20) })).toMatchObject({ ok: false, code: "INVALID_IMAGE" });
    expect(validateImageForUpload({ filename: "A.JPEG", mimeType: "image/jpeg", bytes: jpeg(4472, 4472) })).toMatchObject({ ok: true });
  });
});
