import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { encryptToken, googleTokenContext } from "@/lib/google/crypto";
import {
  downloadDriveImage,
  DriveDownloadError,
  type DriveDownloadDeps,
  type StoreDriveContext,
} from "@/lib/google/download";
import { MAX_IMAGE_BYTES } from "@/lib/shopify/media-validation";
import { jpeg } from "./helpers/fake-shopify";
import { ACCESS, fakeGoogleRepo, G_NOW, G_STORE_ID, G_WORKSPACE_ID, googleConfig, REFRESH, tokenBody } from "./helpers/google-fakes";

const FOLDER = "application/vnd.google-apps.folder";
const ROOT = "rootSofaFolder01";
const OTHER_STORE = "77777777-7777-4777-8777-777777777777";
const OTHER_WS = "88888888-8888-4888-8888-888888888888";
const NEW_ACCESS = "ya29.REFRESHED_ACCESS_SECRET";

/** A real, decodable PNG (w×h RGB). */
function realPng(w = 4, h = 3): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = realPng();
const JPG = Buffer.from(jpeg(640, 480));
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Node = {
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  size?: string | null;
  md5?: string | null;
  bytes?: Buffer;
  private?: boolean;
};

/**
 *   Elsewhere/secret.png                (outside root)
 *   Sofa (ROOT)
 *   ├── SOF-001 / Milano / image-01.png, image-02.jpg, photo.webp(bad bytes), logo.svg, doc.pdf, fake.jpg (PNG bytes),
 *   │                    renamed.png (image/jpeg), trashed.png (trashed), big.png (21 MB meta),
 *   │                    OG / og.png
 *   └── Trash (trashed folder) / lost.png
 */
function tree(): Record<string, Node> {
  const f = (name: string, parent: string, extra: Partial<Node> = {}): Node => ({ name, mimeType: FOLDER, parents: [parent], ...extra });
  const img = (name: string, parent: string, mimeType: string, bytes: Buffer, extra: Partial<Node> = {}): Node => ({
    name,
    mimeType,
    parents: [parent],
    bytes,
    size: String(bytes.length),
    md5: md5(bytes),
    ...extra,
  });
  return {
    [ROOT]: f("Sofa", "myDriveRoot0001"),
    sof001Folder000: f("SOF-001", ROOT),
    milanoFolder0001: f("Milano", "sof001Folder000"),
    ogFolder00000001: f("OG", "milanoFolder0001"),
    trashFolder00001: f("Trash", ROOT, { trashed: true }),
    elsewhere0000001: f("Elsewhere", "myDriveRoot0001"),
    imagePng00000001: img("image-01.png", "milanoFolder0001", "image/png", PNG),
    imageJpg00000002: img("image-02.jpg", "milanoFolder0001", "image/jpeg", JPG),
    badWebp000000001: img("photo.webp", "milanoFolder0001", "image/webp", Buffer.from("RIFF0000WEBPnot-an-image")),
    svgLogo000000001: img("logo.svg", "milanoFolder0001", "image/svg+xml", Buffer.from("<svg/>")),
    pdfDoc0000000001: img("doc.pdf", "milanoFolder0001", "application/pdf", Buffer.from("%PDF-1.7")),
    fakeJpg000000001: img("fake.jpg", "milanoFolder0001", "image/jpeg", PNG),
    renamedPng000001: img("renamed.png", "milanoFolder0001", "image/jpeg", JPG),
    trashedPng000001: img("trashed.png", "milanoFolder0001", "image/png", PNG, { trashed: true }),
    bigPng0000000001: img("big.png", "milanoFolder0001", "image/png", PNG, { size: String(MAX_IMAGE_BYTES + 1) }),
    hugeStream000001: img("huge.png", "milanoFolder0001", "image/png", PNG, { size: null, md5: null }),
    noMd5Png00000001: img("nomd5.png", "milanoFolder0001", "image/png", PNG, { md5: null }),
    ogImage000000001: img("og.png", "ogFolder00000001", "image/png", PNG),
    lostPng000000001: img("lost.png", "trashFolder00001", "image/png", PNG),
    secretPng0000001: img("secret.png", "elsewhere0000001", "image/png", PNG),
    privatePng000001: img("private.png", "milanoFolder0001", "image/png", PNG, { private: true }),
  };
}

type Call = { url: string; auth: string | null; alt: string | null };

function fakeDrive(
  opts: {
    nodes?: Record<string, Node>;
    /** Responses for alt=media requests, consumed in order (default: the node's bytes). */
    media?: (Response | "redirect-google" | "redirect-evil" | "oversize-stream" | "throw-timeout" | "401")[];
    metaStatus?: { status: number; headers?: Record<string, string> };
  } = {},
) {
  const nodes = opts.nodes ?? tree();
  const media = [...(opts.media ?? [])];
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    calls.push({ url: url.href, auth, alt: url.searchParams.get("alt") });
    if (init?.method && init.method !== "GET" && url.href !== "https://oauth2.googleapis.com/token") {
      throw new Error(`Drive mutation attempted: ${init.method} ${url.pathname}`);
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify(tokenBody({ access_token: NEW_ACCESS })), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.hostname.endsWith("googleusercontent.com")) {
      return new Response(new Uint8Array(PNG), { status: 200 });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (url.hostname !== "www.googleapis.com" || !m) throw new Error(`unexpected ${url.href}`);
    const node = nodes[m[1]!];

    if (url.searchParams.get("alt") === "media") {
      const next = media.shift();
      if (next === "throw-timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (next === "401") return new Response("{}", { status: 401 });
      if (next === "redirect-google") {
        return new Response(null, { status: 302, headers: { Location: "https://doc-0s-1a-docs.googleusercontent.com/docs/securesc/abc" } });
      }
      if (next === "redirect-evil") return new Response(null, { status: 302, headers: { Location: "https://evil.example.com/steal" } });
      if (next === "oversize-stream") {
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent > MAX_IMAGE_BYTES + 2 * 1024 * 1024) return controller.close();
            const c = new Uint8Array(1024 * 1024);
            if (sent === 0) c.set(PNG.subarray(0, 32));
            sent += c.length;
            controller.enqueue(c);
          },
        });
        return new Response(stream, { status: 200 });
      }
      if (next instanceof Response) return next;
      if (!node?.bytes) return new Response("{}", { status: 404 });
      return new Response(new Uint8Array(node.bytes), { status: 200, headers: { "Content-Length": String(node.bytes.length) } });
    }

    if (opts.metaStatus) {
      return new Response(JSON.stringify({ error: { code: opts.metaStatus.status } }), {
        status: opts.metaStatus.status,
        headers: { "Content-Type": "application/json", ...(opts.metaStatus.headers ?? {}) },
      });
    }
    if (!node || node.private) {
      return new Response(JSON.stringify({ error: { code: 404, errors: [{ reason: "notFound" }] } }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        id: m[1],
        name: node.name,
        mimeType: node.mimeType,
        parents: node.parents,
        trashed: node.trashed ?? false,
        ...(node.size ? { size: node.size } : {}),
        ...(node.md5 ? { md5Checksum: node.md5 } : {}),
        modifiedTime: "2026-09-30T10:00:00.000Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

function setup(
  drive = fakeDrive(),
  over: { ctx?: Partial<StoreDriveContext>; expiresInMs?: number; credsWorkspace?: string; credsAccount?: string } = {},
) {
  const { repo, state } = fakeGoogleRepo();
  state.creds = {
    connectionId: "gconn-1",
    workspaceId: over.credsWorkspace ?? G_WORKSPACE_ID,
    googleAccountId: over.credsAccount ?? "google-sub-123",
    connectionStatus: "connected",
    encryptedAccessToken: encryptToken(ACCESS, googleConfig.tokenEncryptionKey, googleTokenContext(G_STORE_ID, "access")),
    encryptedRefreshToken: encryptToken(REFRESH, googleConfig.tokenEncryptionKey, googleTokenContext(G_STORE_ID, "refresh")),
    tokenExpiresAt: new Date(G_NOW + (over.expiresInMs ?? 3_600_000)),
    tokenVersion: 1,
    accountShared: false,
  };
  const contexts: Record<string, StoreDriveContext> = {
    [G_STORE_ID]: {
      storeId: G_STORE_ID,
      workspaceId: G_WORKSPACE_ID,
      connectionStatus: "connected",
      googleAccountId: "google-sub-123",
      rootFolderId: ROOT,
      rootFolderName: "Sofa",
      allowedImageTypes: ["jpg", "jpeg", "png", "webp"],
      ignoredFolders: ["OG"],
      ...over.ctx,
    },
    [OTHER_STORE]: {
      storeId: OTHER_STORE,
      workspaceId: OTHER_WS,
      connectionStatus: "connected",
      googleAccountId: "other",
      rootFolderId: "otherRoot000001",
      rootFolderName: "Other",
      allowedImageTypes: ["png"],
      ignoredFolders: ["OG"],
    },
  };
  const deps: DriveDownloadDeps = {
    config: googleConfig,
    repo,
    fetch: drive.fetch,
    now: () => G_NOW,
    downloads: { getStoreDriveContext: vi.fn(async (id: string) => contexts[id] ?? null) },
  };
  return { deps, drive, state };
}

const ctx = (fileId: string, over: Partial<{ workspaceId: string; storeId: string }> = {}) => ({
  workspaceId: G_WORKSPACE_ID,
  storeId: G_STORE_ID,
  fileId,
  ...over,
});

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    expect(e).toBeInstanceOf(DriveDownloadError);
    return (e as DriveDownloadError).code;
  }
}

describe("downloadDriveImage", () => {
  it("1. downloads a valid PNG inside the root, with metadata, md5 and SHA-256", async () => {
    const { deps, drive } = setup();
    const r = await downloadDriveImage(ctx("imagePng00000001"), deps);
    expect(r).toMatchObject({
      fileId: "imagePng00000001",
      filename: "image-01.png",
      mimeType: "image/png",
      size: PNG.length,
      modifiedTime: "2026-09-30T10:00:00.000Z",
      md5Checksum: md5(PNG),
      sha256: sha(PNG),
      width: 4,
      height: 3,
      parentFolderId: "milanoFolder0001",
    });
    expect(Buffer.compare(r.buffer, PNG)).toBe(0);
    // Only GETs; metadata uses fields; the binary uses alt=media.
    expect(drive.calls.some((c) => c.alt === "media")).toBe(true);
  });

  it("2. downloads a valid JPEG", async () => {
    const { deps } = setup();
    const r = await downloadDriveImage(ctx("imageJpg00000002"), deps);
    expect(r).toMatchObject({ mimeType: "image/jpeg", width: 640, height: 480, sha256: sha(JPG) });
  });

  it("3. unsupported types (svg, pdf, folders, not-allowed by store settings) → UNSUPPORTED_MIME_TYPE, no download", async () => {
    const { deps, drive } = setup();
    expect(await code(downloadDriveImage(ctx("svgLogo000000001"), deps))).toBe("UNSUPPORTED_MIME_TYPE");
    expect(await code(downloadDriveImage(ctx("pdfDoc0000000001"), deps))).toBe("UNSUPPORTED_MIME_TYPE");
    expect(await code(downloadDriveImage(ctx("milanoFolder0001"), deps))).toBe("UNSUPPORTED_MIME_TYPE");
    const pngOnly = setup(fakeDrive(), { ctx: { allowedImageTypes: ["png"] } });
    expect(await code(downloadDriveImage(ctx("imageJpg00000002"), pngOnly.deps))).toBe("UNSUPPORTED_MIME_TYPE");
    expect(drive.calls.some((c) => c.alt === "media")).toBe(false);
    expect(pngOnly.drive.calls.some((c) => c.alt === "media")).toBe(false);
  });

  it("4. extension / Drive MIME mismatch → UNSUPPORTED_MIME_TYPE", async () => {
    const { deps } = setup();
    expect(await code(downloadDriveImage(ctx("renamedPng000001"), deps))).toBe("UNSUPPORTED_MIME_TYPE");
  });

  it("5. bytes that don't match the claimed type → INVALID_IMAGE", async () => {
    const { deps } = setup();
    expect(await code(downloadDriveImage(ctx("fakeJpg000000001"), deps))).toBe("INVALID_IMAGE"); // PNG bytes named .jpg
    expect(await code(downloadDriveImage(ctx("badWebp000000001"), deps))).toBe("INVALID_IMAGE");
  });

  it("6. file not found / not readable → DRIVE_FILE_NOT_FOUND", async () => {
    const { deps } = setup();
    expect(await code(downloadDriveImage(ctx("doesNotExist0001"), deps))).toBe("DRIVE_FILE_NOT_FOUND");
    expect(await code(downloadDriveImage(ctx("privatePng000001"), deps))).toBe("DRIVE_FILE_NOT_FOUND");
    expect(await code(downloadDriveImage(ctx("bad/../id"), deps))).toBe("DRIVE_FILE_NOT_FOUND");
  });

  it("7. trashed file (or a file in a trashed folder) is never downloaded", async () => {
    const { deps, drive } = setup();
    expect(await code(downloadDriveImage(ctx("trashedPng000001"), deps))).toBe("DRIVE_FILE_NOT_FOUND");
    expect(await code(downloadDriveImage(ctx("lostPng000000001"), deps))).toBe("DRIVE_FILE_OUTSIDE_ROOT");
    expect(drive.calls.some((c) => c.alt === "media")).toBe(false);
  });

  it("8. a file the account CAN read but outside the root → DRIVE_FILE_OUTSIDE_ROOT; OG → ignored", async () => {
    const { deps, drive } = setup();
    expect(await code(downloadDriveImage(ctx("secretPng0000001"), deps))).toBe("DRIVE_FILE_OUTSIDE_ROOT");
    expect(await code(downloadDriveImage(ctx("ogImage000000001"), deps))).toBe("DRIVE_FILE_IN_IGNORED_FOLDER");
    expect(drive.calls.some((c) => c.alt === "media")).toBe(false);
  });

  it("9. root not selected → GOOGLE_DRIVE_ROOT_NOT_SELECTED; root gone → DRIVE_ROOT_INACCESSIBLE", async () => {
    const a = setup(fakeDrive(), { ctx: { rootFolderId: null } });
    expect(await code(downloadDriveImage(ctx("imagePng00000001"), a.deps))).toBe("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
    expect(a.drive.calls).toHaveLength(0);

    const nodes = tree();
    nodes[ROOT]!.trashed = true;
    const b = setup(fakeDrive({ nodes }));
    expect(await code(downloadDriveImage(ctx("imagePng00000001"), b.deps))).toBe("DRIVE_ROOT_INACCESSIBLE");

    // Root selected with another Google account than the one now connected.
    const c = setup(fakeDrive(), { credsAccount: "someone-else" });
    expect(await code(downloadDriveImage(ctx("imagePng00000001"), c.deps))).toBe("GOOGLE_DRIVE_ROOT_NOT_SELECTED");
  });

  it("10. Google disconnected / needs reconnect → GOOGLE_DRIVE_NOT_CONNECTED", async () => {
    for (const status of ["disconnected", "needs_reconnect", "pending", null]) {
      const s = setup(fakeDrive(), { ctx: { connectionStatus: status } });
      expect(await code(downloadDriveImage(ctx("imagePng00000001"), s.deps))).toBe("GOOGLE_DRIVE_NOT_CONNECTED");
      expect(s.drive.calls).toHaveLength(0);
    }
    const noCreds = setup();
    noCreds.state.creds = null;
    expect(await code(downloadDriveImage(ctx("imagePng00000001"), noCreds.deps))).toBe("GOOGLE_DRIVE_NOT_CONNECTED");
  });

  it("11. metadata size over 20 MB → IMAGE_TOO_LARGE before downloading", async () => {
    const { deps, drive } = setup();
    expect(await code(downloadDriveImage(ctx("bigPng0000000001"), deps))).toBe("IMAGE_TOO_LARGE");
    expect(drive.calls.some((c) => c.alt === "media")).toBe(false);
  });

  it("12. response body exceeding 20 MB (no/incorrect size) is aborted while streaming", async () => {
    const { deps } = setup(fakeDrive({ media: ["oversize-stream"] }));
    expect(await code(downloadDriveImage(ctx("hugeStream000001"), deps))).toBe("IMAGE_TOO_LARGE");
    const lying = setup(
      fakeDrive({ media: [new Response(new Uint8Array(10), { status: 200, headers: { "Content-Length": String(MAX_IMAGE_BYTES + 5) } })] }),
    );
    expect(await code(downloadDriveImage(ctx("hugeStream000001"), lying.deps))).toBe("IMAGE_TOO_LARGE");
  });

  it("13. Google 429 → retryable GOOGLE_DRIVE_THROTTLED with Retry-After", async () => {
    const meta = setup(fakeDrive({ metaStatus: { status: 429, headers: { "Retry-After": "12" } } }));
    await expect(downloadDriveImage(ctx("imagePng00000001"), meta.deps)).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_THROTTLED",
      retryable: true,
      retryAfterSeconds: 12,
    });
    const bin = setup(fakeDrive({ media: [new Response("{}", { status: 429, headers: { "Retry-After": "5" } })] }));
    await expect(downloadDriveImage(ctx("imagePng00000001"), bin.deps)).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_THROTTLED",
      retryAfterSeconds: 5,
    });
  });

  it("14. Google 5xx → retryable GOOGLE_DRIVE_UNAVAILABLE", async () => {
    const meta = setup(fakeDrive({ metaStatus: { status: 503 } }));
    await expect(downloadDriveImage(ctx("imagePng00000001"), meta.deps)).rejects.toMatchObject({ code: "GOOGLE_DRIVE_UNAVAILABLE", retryable: true });
    const bin = setup(fakeDrive({ media: [new Response("{}", { status: 500 })] }));
    await expect(downloadDriveImage(ctx("imagePng00000001"), bin.deps)).rejects.toMatchObject({ code: "GOOGLE_DRIVE_UNAVAILABLE", retryable: true });
  });

  it("15. network timeout → retryable NETWORK_ERROR", async () => {
    const { deps } = setup(fakeDrive({ media: ["throw-timeout"] }));
    await expect(downloadDriveImage(ctx("imagePng00000001"), deps)).rejects.toMatchObject({ code: "NETWORK_ERROR", retryable: true });
  });

  it("16 + 17. md5Checksum returned when Drive has it, null when it doesn't", async () => {
    const { deps } = setup();
    expect((await downloadDriveImage(ctx("imagePng00000001"), deps)).md5Checksum).toBe(md5(PNG));
    expect((await downloadDriveImage(ctx("noMd5Png00000001"), deps)).md5Checksum).toBeNull();
  });

  it("18. SHA-256 is computed from the downloaded bytes; corrupted transfers are rejected", async () => {
    const { deps } = setup();
    const r = await downloadDriveImage(ctx("imagePng00000001"), deps);
    expect(r.sha256).toBe(createHash("sha256").update(r.buffer).digest("hex"));
    expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);

    const corrupted = Buffer.from(PNG);
    corrupted[corrupted.length - 5] ^= 0xff;
    const bad = setup(fakeDrive({ media: [new Response(new Uint8Array(corrupted), { status: 200 })] }));
    await expect(downloadDriveImage(ctx("imagePng00000001"), bad.deps)).rejects.toMatchObject({
      code: "DOWNLOAD_INTEGRITY_FAILED",
      retryable: true,
    });
  });

  it("19. the Google token is never exposed (result, errors, redirects) and refreshes after 401", async () => {
    const { deps, drive } = setup(fakeDrive({ media: ["401", "redirect-google"] }));
    const r = await downloadDriveImage(ctx("imagePng00000001"), deps);
    const text = JSON.stringify(r);
    for (const secret of [ACCESS, REFRESH, NEW_ACCESS, "Bearer"]) expect(text).not.toContain(secret);
    expect(text).not.toContain("buffer"); // bytes are not serialised
    expect(Object.keys(r)).not.toContain("buffer");
    // Authorization only to www.googleapis.com; never to the googleusercontent redirect host.
    for (const c of drive.calls) {
      if (!new URL(c.url).hostname.endsWith("googleapis.com")) expect(c.auth).toBeNull();
    }
    expect(drive.calls.some((c) => c.auth === `Bearer ${NEW_ACCESS}`)).toBe(true); // forced refresh after 401

    // A redirect to a non-Google host is refused and the token is not sent there.
    const evil = setup(fakeDrive({ media: ["redirect-evil"] }));
    const e = await downloadDriveImage(ctx("imagePng00000001"), evil.deps).catch((x) => x);
    expect(e).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(evil.drive.calls.some((c) => c.url.startsWith("https://evil.example.com"))).toBe(false);
    for (const secret of [ACCESS, REFRESH]) expect(JSON.stringify({ ...e, message: e.message, pm: e.publicMessage })).not.toContain(secret);
  });

  it("20. cross-workspace / cross-store access is denied before any Google call", async () => {
    const { deps, drive } = setup();
    expect(await code(downloadDriveImage(ctx("imagePng00000001", { workspaceId: OTHER_WS }), deps))).toBe("STORE_NOT_FOUND");
    expect(await code(downloadDriveImage(ctx("imagePng00000001", { storeId: OTHER_STORE }), deps))).toBe("STORE_NOT_FOUND");
    expect(await code(downloadDriveImage(ctx("imagePng00000001", { storeId: "99999999-9999-4999-8999-999999999999" }), deps))).toBe("STORE_NOT_FOUND");
    expect(await code(downloadDriveImage(ctx("imagePng00000001", { storeId: "not-a-uuid" }), deps))).toBe("STORE_NOT_FOUND");
    expect(drive.calls).toHaveLength(0);

    // Stored credentials that belong to another workspace are refused too.
    const mixed = setup(fakeDrive(), { credsWorkspace: OTHER_WS });
    expect(await code(downloadDriveImage(ctx("imagePng00000001"), mixed.deps))).toBe("STORE_NOT_FOUND");
    expect(mixed.drive.calls.some((c) => c.alt === "media")).toBe(false);
  });

  it("refreshes an expiring token through the existing connection service", async () => {
    const { deps, drive } = setup(fakeDrive(), { expiresInMs: 60_000 });
    const r = await downloadDriveImage(ctx("imagePng00000001"), deps);
    expect(r.sha256).toBe(sha(PNG));
    expect(drive.calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(drive.calls.filter((c) => c.url.includes("googleapis.com/drive")).every((c) => c.auth === `Bearer ${NEW_ACCESS}`)).toBe(true);
  });
});
