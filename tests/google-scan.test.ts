import { describe, expect, it, vi } from "vitest";

import { encryptToken as encryptGoogle, googleTokenContext } from "@/lib/google/crypto";
import type { StoreDriveContext } from "@/lib/google/download";
import { scanCategoryRoots, type ScanDeps } from "@/lib/google/scan";
import { encryptToken as encryptShopify, tokenContext } from "@/lib/shopify/crypto";
import { searchProducts } from "@/lib/shopify/products";
import { ACCESS, fakeGoogleRepo, G_NOW, G_STORE_ID, G_WORKSPACE_ID, googleConfig, REFRESH } from "./helpers/google-fakes";
import { config as shopifyConfig, fakeRepo as fakeShopifyRepo, SHOP } from "./helpers/shopify-fakes";

const FOLDER = "application/vnd.google-apps.folder";
const SOFA = "rootSofaImage001";
const SOFA_BED = "rootSofaBedImg01";
const ELSEWHERE = "elsewhereFolder1";
const OTHER_WS = "88888888-8888-4888-8888-888888888888";
const OTHER_STORE = "77777777-7777-4777-8777-777777777777";

type Node = { id: string; name: string; mimeType: string; parent: string; size?: string; md5?: string; trashed?: boolean };

/**
 *   Sofa image (SOFA)
 *   ├── SOF-001 / Milano / 1.jpg, 2.jpg, 3.png, logo.svg, spec.pdf, all.zip, raw.heic, OG/og.jpg, Angles/side.jpg
 *   ├── SOF-002 / Roma   / 1.jpg, 2.jpg
 *   ├── SOF-003 / Minor  / 1.jpg, 2.webp
 *   ├── OG / hidden / x.jpg                      (ignored code folder)
 *   ├── EMPTY-CODE                               (no product folder)
 *   └── loose.jpg                                (image directly in the root)
 *   Sofa bed image (SOFA_BED)
 *   ├── SOFB-001 / Durres        / 1.jpg, 2.jpg
 *   └── SOFB-002 / Roma Sofa Bed / 1.jpg
 *   Elsewhere (NOT connected) / CODE-9 / Secret / 1.jpg
 */
function tree(): Node[] {
  const nodes: Node[] = [];
  const folder = (id: string, name: string, parent: string) => (nodes.push({ id, name, mimeType: FOLDER, parent }), id);
  const file = (id: string, name: string, parent: string, mimeType: string, size = "2048") =>
    nodes.push({ id, name, mimeType, parent, size, md5: `md5-${id}` });
  folder(SOFA, "Sofa image", "myDrive");
  folder(SOFA_BED, "Sofa bed image", "myDrive");
  folder(ELSEWHERE, "Elsewhere", "myDrive");
  const s1 = folder("codeSof001xxxx", "SOF-001", SOFA);
  const milano = folder("prodMilanoxxxxx", "Milano", s1);
  file("milano1jpgxxxxx", "1.jpg", milano, "image/jpeg");
  file("milano2jpgxxxxx", "2.jpg", milano, "image/jpeg");
  file("milano3pngxxxxx", "3.png", milano, "image/png");
  file("milanoSvgxxxxxx", "logo.svg", milano, "image/svg+xml");
  file("milanoPdfxxxxxx", "spec.pdf", milano, "application/pdf");
  file("milanoZipxxxxxx", "all.zip", milano, "application/zip");
  file("milanoHeicxxxxx", "raw.heic", milano, "image/heic");
  const og = folder("milanoOGxxxxxxx", "og", milano);
  file("milanoOgImgxxxx", "og.jpg", og, "image/jpeg");
  const angles = folder("milanoAnglesxxx", "Angles", milano);
  file("milanoSidexxxxx", "side.jpg", angles, "image/jpeg");
  const s2 = folder("codeSof002xxxx", "SOF-002", SOFA);
  const roma = folder("prodRomaxxxxxxx", "Roma", s2);
  file("roma1jpgxxxxxxx", "1.jpg", roma, "image/jpeg");
  file("roma2jpgxxxxxxx", "2.jpg", roma, "image/jpeg");
  const s3 = folder("codeSof003xxxx", "SOF-003", SOFA);
  const minor = folder("prodMinorxxxxxx", "Minor", s3);
  file("minor1jpgxxxxxx", "1.jpg", minor, "image/jpeg");
  file("minor2webpxxxxx", "2.webp", minor, "image/webp");
  const ogCode = folder("codeOGxxxxxxxxx", "OG", SOFA);
  const hidden = folder("hiddenProdxxxxx", "hidden", ogCode);
  file("hiddenImgxxxxxx", "x.jpg", hidden, "image/jpeg");
  folder("codeEmptyxxxxxx", "EMPTY-CODE", SOFA);
  file("looseRootJpgxxx", "loose.jpg", SOFA, "image/jpeg");
  const b1 = folder("codeSofb001xxxx", "SOFB-001", SOFA_BED);
  const durres = folder("prodDurresxxxxx", "Durres", b1);
  file("durres1jpgxxxxx", "1.jpg", durres, "image/jpeg");
  file("durres2jpgxxxxx", "2.jpg", durres, "image/jpeg");
  const b2 = folder("codeSofb002xxxx", "SOFB-002", SOFA_BED);
  const romaBed = folder("prodRomaBedxxxx", "Roma Sofa Bed", b2);
  file("romaBed1jpgxxxx", "1.jpg", romaBed, "image/jpeg");
  const c9 = folder("codeNinexxxxxxx", "CODE-9", ELSEWHERE);
  const secret = folder("prodSecretxxxxx", "Secret", c9);
  file("secret1jpgxxxxx", "1.jpg", secret, "image/jpeg");
  return nodes;
}

type DriveCall = { path: string; q: string | null; pageToken: string | null };

function fakeDrive(opts: { nodes?: Node[]; fail?: { status: number; headers?: Record<string, string>; afterCalls?: number } } = {}) {
  const nodes = opts.nodes ?? tree();
  const calls: DriveCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") !== "GET") throw new Error(`Drive mutation attempted: ${init?.method}`);
    if (url.hostname !== "www.googleapis.com") throw new Error(`unexpected host ${url.hostname}`);
    if (url.searchParams.get("alt") === "media") throw new Error("scanner must never download bytes");
    calls.push({ path: url.pathname, q: url.searchParams.get("q"), pageToken: url.searchParams.get("pageToken") });
    if (opts.fail && calls.length > (opts.fail.afterCalls ?? 0)) {
      return new Response(JSON.stringify({ error: { code: opts.fail.status } }), { status: opts.fail.status, headers: opts.fail.headers });
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const n = nodes.find((x) => x.id === one[1]);
      if (!n) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
      return Response.json({ id: n.id, name: n.name, mimeType: n.mimeType, parents: [n.parent], trashed: n.trashed ?? false });
    }
    if (url.pathname !== "/drive/v3/files") throw new Error(`unexpected ${url.pathname}`);
    const q = url.searchParams.get("q") ?? "";
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const wantFolders = q.includes(`mimeType = '${FOLDER}'`);
    const children = nodes
      .filter((n) => n.parent === parent && !n.trashed && (wantFolders ? n.mimeType === FOLDER : n.mimeType !== FOLDER))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    const size = Number(url.searchParams.get("pageSize") ?? "100");
    const start = Number(url.searchParams.get("pageToken") ?? "0");
    const page = children.slice(start, start + size);
    const next = start + size < children.length ? String(start + size) : undefined;
    return Response.json({
      files: page.map((n) => ({ id: n.id, name: n.name, mimeType: n.mimeType, size: n.size, md5Checksum: n.md5, modifiedTime: "2026-09-30T10:00:00.000Z" })),
      ...(next ? { nextPageToken: next } : {}),
    });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const CATALOG = ["Milano 3 Seater Sofa", "Roma Sofa", "Roma Sofa Bed", "Durres Sofa Bed", "SOF-001 Special Edition", "Sofa image cushion"];

/** Fake Shopify Admin GraphQL: word-prefix title search like Shopify; the real searchProducts() filters by "contains". */
function fakeShopify(opts: { fail?: "throttled" | "unauthorized" } = {}) {
  const terms: string[] = [];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { variables: { query: string } };
    const words = [...body.variables.query.matchAll(/title:([^\s*]+)\*/g)].map((m) => m[1]!);
    terms.push(words.join(" "));
    if (opts.fail === "throttled") return new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
    if (opts.fail === "unauthorized") return new Response("{}", { status: 401 });
    const nodes = CATALOG.map((title, i) => ({ title, i }))
      .filter(({ title }) => words.every((w) => title.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.startsWith(w))))
      .map(({ title, i }) => ({
        id: `gid://shopify/Product/${100 + i}`,
        legacyResourceId: String(100 + i),
        title,
        handle: title.toLowerCase().replace(/\s+/g, "-"),
        status: "ACTIVE",
        vendor: "BrandSure",
        productType: "Sofa",
        mediaCount: { count: 0, precision: "EXACT" },
      }));
    return Response.json({ data: { products: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, terms };
}

function setup(
  over: {
    drive?: ReturnType<typeof fakeDrive>;
    shopify?: ReturnType<typeof fakeShopify>;
    ctx?: Partial<StoreDriveContext>;
    limits?: ScanDeps["limits"];
  } = {},
) {
  const drive = over.drive ?? fakeDrive();
  const shop = over.shopify ?? fakeShopify();
  const g = fakeGoogleRepo();
  g.state.creds = {
    connectionId: "gconn-1",
    workspaceId: G_WORKSPACE_ID,
    googleAccountId: "google-sub-123",
    connectionStatus: "connected",
    encryptedAccessToken: encryptGoogle(ACCESS, googleConfig.tokenEncryptionKey, googleTokenContext(G_STORE_ID, "access")),
    encryptedRefreshToken: encryptGoogle(REFRESH, googleConfig.tokenEncryptionKey, googleTokenContext(G_STORE_ID, "refresh")),
    tokenExpiresAt: new Date(G_NOW + 3_600_000),
    tokenVersion: 1,
    accountShared: false,
  };
  const s = fakeShopifyRepo();
  s.state.creds = {
    connectionId: "sconn-1",
    workspaceId: G_WORKSPACE_ID,
    shopDomain: SHOP,
    connectionStatus: "connected",
    encryptedAccessToken: encryptShopify("shpat_SCAN_SECRET", shopifyConfig.tokenEncryptionKey, tokenContext(G_STORE_ID, SHOP, "access")),
    encryptedRefreshToken: null,
    tokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    tokenVersion: 1,
  };
  const contexts: Record<string, StoreDriveContext> = {
    [G_STORE_ID]: {
      storeId: G_STORE_ID,
      workspaceId: G_WORKSPACE_ID,
      connectionStatus: "connected",
      googleAccountId: "google-sub-123",
      rootFolderId: SOFA,
      rootFolderName: "Sofa image",
      categoryRoots: [{ id: SOFA, name: "Sofa image" }],
      allowedImageTypes: ["jpg", "jpeg", "png", "webp"],
      ignoredFolders: ["OG"],
      ...over.ctx,
    },
    [OTHER_STORE]: {
      storeId: OTHER_STORE,
      workspaceId: OTHER_WS,
      connectionStatus: "connected",
      googleAccountId: "other",
      rootFolderId: ELSEWHERE,
      rootFolderName: "Elsewhere",
      categoryRoots: [{ id: ELSEWHERE, name: "Elsewhere" }],
      allowedImageTypes: ["jpg"],
      ignoredFolders: ["OG"],
    },
  };
  const searchSpy = vi.fn(searchProducts);
  const deps: ScanDeps = {
    google: {
      config: googleConfig,
      repo: g.repo,
      fetch: drive.fetch,
      now: () => G_NOW,
      downloads: { getStoreDriveContext: vi.fn(async (id: string) => contexts[id] ?? null) },
    },
    shopify: { config: shopifyConfig, repo: s.repo, fetch: shop.fetch, now: () => G_NOW },
    limits: over.limits,
    searchProducts: searchSpy,
  };
  return { deps, drive, shop, searchSpy };
}

const both = { categoryRoots: [{ id: SOFA, name: "Sofa image" }, { id: SOFA_BED, name: "Sofa bed image" }] };
const scan = (deps: ScanDeps, over: Partial<{ workspaceId: string; storeId: string; categoryRootIds: string[] }> = {}) =>
  scanCategoryRoots({ workspaceId: G_WORKSPACE_ID, storeId: G_STORE_ID, ...over }, deps);
const byProduct = (r: Awaited<ReturnType<typeof scan>>, name: string) => r.items.find((i) => i.product_folder.name === name)!;

describe("scanCategoryRoots — structure", () => {
  it("1. one category root: code folders → product folders → images", async () => {
    const { deps } = setup();
    const r = await scan(deps);
    expect(r.category_roots).toEqual([{ id: SOFA, name: "Sofa image", code_folders: 4, product_folders: 3, images: 7, accessible: true }]);
    expect(r.items.map((i) => `${i.category_root.name} / ${i.code_folder.name} / ${i.product_folder.name}`)).toEqual([
      "Sofa image / SOF-001 / Milano",
      "Sofa image / SOF-002 / Roma",
      "Sofa image / SOF-003 / Minor",
    ]);
  });

  it("2. multiple category roots (Sofa image + Sofa bed image) are scanned together", async () => {
    const { deps } = setup({ ctx: both });
    const r = await scan(deps);
    expect(r.category_roots.map((c) => [c.name, c.product_folders])).toEqual([
      ["Sofa image", 3],
      ["Sofa bed image", 2],
    ]);
    expect(r.items.map((i) => i.product_folder.name)).toEqual(["Milano", "Roma", "Minor", "Durres", "Roma Sofa Bed"]);
    // A subset can be requested, but only of connected roots.
    const only = await scan(deps, { categoryRootIds: [SOFA_BED] });
    expect(only.items.map((i) => i.product_folder.name)).toEqual(["Durres", "Roma Sofa Bed"]);
  });

  it("3 + 4. code folders SOF-001 and SOF-002 are discovered automatically (never configured)", async () => {
    const { deps } = setup();
    const r = await scan(deps);
    const codes = r.items.map((i) => i.code_folder);
    expect(codes).toContainEqual({ id: "codeSof001xxxx", name: "SOF-001" });
    expect(codes).toContainEqual({ id: "codeSof002xxxx", name: "SOF-002" });
    expect(r.warnings).toContainEqual(expect.objectContaining({ type: "code_folder_without_product_folders", folder_name: "EMPTY-CODE" }));
  });

  it("5. product folders are discovered beneath code folders", async () => {
    const { deps } = setup();
    const milano = byProduct(await scan(deps), "Milano");
    expect(milano.product_folder).toEqual({ id: "prodMilanoxxxxx", name: "Milano" });
    expect(milano.code_folder.name).toBe("SOF-001");
    // Sub-folders inside a product folder are reported, never treated as products.
    expect(milano.nested_folders).toEqual([{ id: "milanoAnglesxxx", name: "Angles" }]);
  });
});

describe("scanCategoryRoots — matching", () => {
  it("6 + 7 + 8. ONLY the product folder name is searched — never the code folder, root or filenames", async () => {
    const { deps, shop, searchSpy } = setup({ ctx: both });
    await scan(deps);
    const searched = searchSpy.mock.calls.map((c) => c[0].searchTerm);
    expect(searched).toEqual(["Milano", "Roma", "Minor", "Durres", "Roma Sofa Bed"]);
    for (const forbidden of ["SOF-001", "SOF-002", "SOFB-001", "Sofa image", "Sofa bed image", "1.jpg"]) {
      expect(searched).not.toContain(forbidden);
    }
    expect(shop.terms.join(" | ")).not.toMatch(/sof-?001|image|jpg/i);
  });

  it("12. zero matches → no_product_found", async () => {
    const { deps } = setup();
    expect(byProduct(await scan(deps), "Minor").match).toEqual({ outcome: "no_product_found", products: [], truncated: false });
  });

  it("13. one match → single_match (with the product)", async () => {
    const { deps } = setup();
    const m = byProduct(await scan(deps), "Milano").match;
    expect(m).toMatchObject({ outcome: "single_match", products: [{ id: "gid://shopify/Product/100", title: "Milano 3 Seater Sofa" }] });
  });

  it("14. multiple matches → multiple_matches with ALL candidates, none chosen", async () => {
    const { deps } = setup({ ctx: both });
    const r = await scan(deps);
    const roma = byProduct(r, "Roma").match;
    expect(roma.outcome).toBe("multiple_matches");
    expect(roma.products.map((p) => p.title)).toEqual(["Roma Sofa", "Roma Sofa Bed"]);
    expect(byProduct(r, "Roma Sofa Bed").match).toMatchObject({ outcome: "single_match", products: [{ title: "Roma Sofa Bed" }] });
  });

  it("22. Shopify search errors: throttling → search_failed per folder; reconnect needed → whole scan stops", async () => {
    const throttled = setup({ shopify: fakeShopify({ fail: "throttled" }) });
    const r = await scan(throttled.deps);
    expect(byProduct(r, "Milano").match).toMatchObject({ outcome: "search_failed", error: { code: "SHOPIFY_THROTTLED", retryable: true } });
    expect(r.items).toHaveLength(3); // structure still reported

    const revoked = setup({ shopify: fakeShopify({ fail: "unauthorized" }) });
    await expect(scan(revoked.deps)).rejects.toMatchObject({ code: "SHOPIFY_NOT_CONNECTED", retryable: false });
  });
});

describe("scanCategoryRoots — images, ignored and unsupported", () => {
  it("9. image metadata is preserved (file id, folder id, name, MIME, size, modified time, md5) — no bytes", async () => {
    const { deps, drive } = setup();
    const milano = byProduct(await scan(deps), "Milano");
    expect(milano.images).toEqual([
      { fileId: "milano1jpgxxxxx", folderId: "prodMilanoxxxxx", filename: "1.jpg", mimeType: "image/jpeg", size: 2048, modifiedTime: "2026-09-30T10:00:00.000Z", md5Checksum: "md5-milano1jpgxxxxx" },
      { fileId: "milano2jpgxxxxx", folderId: "prodMilanoxxxxx", filename: "2.jpg", mimeType: "image/jpeg", size: 2048, modifiedTime: "2026-09-30T10:00:00.000Z", md5Checksum: "md5-milano2jpgxxxxx" },
      { fileId: "milano3pngxxxxx", folderId: "prodMilanoxxxxx", filename: "3.png", mimeType: "image/png", size: 2048, modifiedTime: "2026-09-30T10:00:00.000Z", md5Checksum: "md5-milano3pngxxxxx" },
    ]);
    expect(drive.calls.every((c) => !c.path.includes("alt=media"))).toBe(true);
  });

  it("10. OG folders are ignored (case-insensitive), at code and product level; their images never appear", async () => {
    const { deps } = setup();
    const r = await scan(deps);
    const allIds = r.items.flatMap((i) => i.images.map((x) => x.fileId));
    expect(allIds).not.toContain("milanoOgImgxxxx");
    expect(allIds).not.toContain("hiddenImgxxxxxx");
    expect(r.items.map((i) => i.code_folder.name)).not.toContain("OG");
    expect(r.items.map((i) => i.product_folder.name)).not.toContain("hidden");
    expect(r.stats.ignored_folders).toBe(2);
  });

  it("11. unsupported files (svg, pdf, zip, heic when not enabled) are ignored", async () => {
    const { deps } = setup();
    const r = await scan(deps);
    expect(byProduct(r, "Milano").images.map((i) => i.filename)).toEqual(["1.jpg", "2.jpg", "3.png"]);
    expect(r.stats.unsupported_files).toBe(4);
    // Store settings decide: png not allowed → png skipped too.
    const jpgOnly = setup({ ctx: { allowedImageTypes: ["jpg", "jpeg"] } });
    expect(byProduct(await scan(jpgOnly.deps), "Milano").images.map((i) => i.filename)).toEqual(["1.jpg", "2.jpg"]);
  });

  it("15. the same filename in different product folders stays separate (Drive file id = identity)", async () => {
    const { deps } = setup();
    const r = await scan(deps);
    const ones = r.items.flatMap((i) => i.images.filter((x) => x.filename === "1.jpg").map((x) => [x.fileId, x.folderId]));
    expect(ones).toEqual([
      ["milano1jpgxxxxx", "prodMilanoxxxxx"],
      ["roma1jpgxxxxxxx", "prodRomaxxxxxxx"],
      ["minor1jpgxxxxxx", "prodMinorxxxxxx"],
    ]);
  });

  it("warns about images directly in a category root (not synced)", async () => {
    const { deps } = setup();
    expect((await scan(deps)).warnings).toContainEqual(expect.objectContaining({ type: "images_in_category_root", category_root_id: SOFA }));
  });
});

describe("scanCategoryRoots — pagination, limits, security, errors", () => {
  it("16. Drive pagination is followed (pageSize 2) and finds everything", async () => {
    const { deps, drive } = setup({ ctx: both, limits: { pageSize: 2 } });
    const r = await scan(deps);
    expect(r.items.map((i) => i.product_folder.name)).toEqual(["Milano", "Roma", "Minor", "Durres", "Roma Sofa Bed"]);
    expect(byProduct(r, "Milano").images).toHaveLength(3);
    expect(drive.calls.some((c) => c.pageToken)).toBe(true);
    // Bounded: a hard limit stops early with a warning instead of loading everything.
    const capped = setup({ limits: { pageSize: 1, maxCodeFoldersPerRoot: 2 } });
    const rc = await scan(capped.deps);
    expect(rc.warnings).toContainEqual(expect.objectContaining({ type: "limit_reached" }));
    expect(rc.stats.code_folders).toBeLessThanOrEqual(2);
  });

  it("17. cross-workspace / cross-store / unconnected roots are rejected before scanning", async () => {
    const { deps, drive } = setup();
    await expect(scan(deps, { workspaceId: OTHER_WS })).rejects.toMatchObject({ code: "STORE_NOT_FOUND" });
    await expect(scan(deps, { storeId: OTHER_STORE })).rejects.toMatchObject({ code: "STORE_NOT_FOUND" });
    // Another store's root (or any folder that isn't a connected category root) can't become a scan root.
    await expect(scan(deps, { categoryRootIds: [ELSEWHERE] })).rejects.toMatchObject({ code: "CATEGORY_ROOT_NOT_CONNECTED" });
    await expect(scan(deps, { categoryRootIds: ["codeSof001xxxx"] })).rejects.toMatchObject({ code: "CATEGORY_ROOT_NOT_CONNECTED" });
    expect(drive.calls).toHaveLength(0);
  });

  it("18. no category root connected → GOOGLE_DRIVE_ROOT_NOT_SELECTED", async () => {
    const { deps, drive } = setup({ ctx: { categoryRoots: [], rootFolderId: null } });
    await expect(scan(deps)).rejects.toMatchObject({ code: "GOOGLE_DRIVE_ROOT_NOT_SELECTED", retryable: false });
    expect(drive.calls).toHaveLength(0);
  });

  it("19. Google disconnected → GOOGLE_DRIVE_NOT_CONNECTED", async () => {
    for (const status of ["disconnected", "needs_reconnect", null]) {
      const { deps, drive } = setup({ ctx: { connectionStatus: status } });
      await expect(scan(deps)).rejects.toMatchObject({ code: "GOOGLE_DRIVE_NOT_CONNECTED" });
      expect(drive.calls).toHaveLength(0);
    }
  });

  it("20. Drive 429 → retryable GOOGLE_DRIVE_THROTTLED with Retry-After", async () => {
    const { deps } = setup({ drive: fakeDrive({ fail: { status: 429, headers: { "Retry-After": "9" }, afterCalls: 3 } }) });
    await expect(scan(deps)).rejects.toMatchObject({ code: "GOOGLE_DRIVE_THROTTLED", retryable: true, retryAfterSeconds: 9 });
  });

  it("21. Drive 5xx → retryable GOOGLE_DRIVE_UNAVAILABLE", async () => {
    const { deps } = setup({ drive: fakeDrive({ fail: { status: 503 } }) });
    await expect(scan(deps)).rejects.toMatchObject({ code: "GOOGLE_DRIVE_UNAVAILABLE", retryable: true });
  });

  it("an inaccessible (trashed) category root is reported, the others are still scanned", async () => {
    const nodes = tree().map((n) => (n.id === SOFA_BED ? { ...n, trashed: true } : n));
    const { deps } = setup({ drive: fakeDrive({ nodes }), ctx: both });
    const r = await scan(deps);
    expect(r.category_roots.find((c) => c.id === SOFA_BED)).toMatchObject({ accessible: false });
    expect(r.warnings).toContainEqual(expect.objectContaining({ type: "category_root_inaccessible", category_root_id: SOFA_BED }));
    expect(r.items.map((i) => i.product_folder.name)).toEqual(["Milano", "Roma", "Minor"]);
  });

  it("result contains no tokens or secrets and the scan makes no Drive writes", async () => {
    const { deps, drive } = setup({ ctx: both });
    const text = JSON.stringify(await scan(deps));
    for (const secret of [ACCESS, REFRESH, "shpat_", "Bearer", "GOCSPX"]) expect(text).not.toContain(secret);
    expect(drive.calls.length).toBeGreaterThan(0); // all GETs (non-GET throws in the fake)
  });
});
