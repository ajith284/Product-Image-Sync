/**
 * Image checks done BEFORE anything is sent to Shopify (pure, no I/O).
 *
 * Shopify product images (Admin API 2026-07, product media guide):
 *   formats PNG / JPEG / WEBP / GIF / HEIC · max 20 MB · max 4472 × 4472 px ·
 *   aspect ratio between 100:1 and 1:100.
 * The type is checked three ways: file extension, declared MIME type and the
 * file's own header bytes, so a renamed or corrupt file never reaches Shopify.
 */

export const SUPPORTED_IMAGE_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
} as const;

export type SupportedMimeType = (typeof SUPPORTED_IMAGE_TYPES)[keyof typeof SUPPORTED_IMAGE_TYPES];

export const SUPPORTED_MIME_TYPES: readonly SupportedMimeType[] = [...new Set(Object.values(SUPPORTED_IMAGE_TYPES))];
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4472;
export const MAX_ASPECT_RATIO = 100;

export type ImageInfo = { mimeType: SupportedMimeType; width: number; height: number };

export type ImageValidationResult =
  | { ok: true; mimeType: SupportedMimeType; width: number; height: number; size: number }
  | { ok: false; code: "UNSUPPORTED_MIME_TYPE" | "IMAGE_TOO_LARGE" | "INVALID_IMAGE"; message: string };

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) >>> 0) + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan before a frame header
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const HEIC_SCAN_LIMIT = 1024 * 1024;

/** HEIC: the largest `ispe` (image spatial extents) property = the primary image size. */
function heicSize(b: Uint8Array): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  const end = Math.min(b.length - 16, HEIC_SCAN_LIMIT);
  for (let o = 4; o < end; o++) {
    if (b[o] === 0x69 && b[o + 1] === 0x73 && b[o + 2] === 0x70 && b[o + 3] === 0x65) {
      // "ispe" + version/flags (4) + width (4) + height (4)
      const width = u32be(b, o + 8);
      const height = u32be(b, o + 12);
      if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
    }
  }
  return best;
}

/** Reads the real type and pixel size from the file header. null = not a supported image. */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return s ? { mimeType: "image/jpeg", ...s } : null;
  }
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a && ascii(b, 12, 4) === "IHDR") {
    return { mimeType: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  const head6 = ascii(b, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") {
    return { mimeType: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const s = webpSize(b);
    return s ? { mimeType: "image/webp", ...s } : null;
  }
  if (ascii(b, 4, 4) === "ftyp" && HEIC_BRANDS.has(ascii(b, 8, 4))) {
    const s = heicSize(b);
    return s ? { mimeType: "image/heic", ...s } : null;
  }
  return null;
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : "";
}

/** Full pre-upload validation: extension + MIME + header bytes + size + dimensions. */
export function validateImageForUpload(input: { filename: string; mimeType: string; bytes: Uint8Array }): ImageValidationResult {
  const ext = extensionOf(input.filename);
  const declared = input.mimeType.trim().toLowerCase();
  const fromExt = (SUPPORTED_IMAGE_TYPES as Record<string, SupportedMimeType>)[ext];

  if (!fromExt || !(SUPPORTED_MIME_TYPES as readonly string[]).includes(declared)) {
    return { ok: false, code: "UNSUPPORTED_MIME_TYPE", message: "Only JPG, JPEG, PNG, WEBP, GIF and HEIC images can be uploaded." };
  }
  if (fromExt !== declared) {
    return { ok: false, code: "UNSUPPORTED_MIME_TYPE", message: "The file extension doesn't match the image type." };
  }
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, code: "INVALID_IMAGE", message: "The image file is empty." };
  if (size > MAX_IMAGE_BYTES) return { ok: false, code: "IMAGE_TOO_LARGE", message: "Images must be 20 MB or smaller." };

  const info = inspectImage(input.bytes);
  if (!info) return { ok: false, code: "INVALID_IMAGE", message: "This file isn't a readable image." };
  if (info.mimeType !== declared) {
    return { ok: false, code: "INVALID_IMAGE", message: "The file content doesn't match its image type." };
  }
  if (info.width < 1 || info.height < 1) return { ok: false, code: "INVALID_IMAGE", message: "The image has no size." };
  if (info.width > MAX_IMAGE_DIMENSION || info.height > MAX_IMAGE_DIMENSION) {
    return { ok: false, code: "IMAGE_TOO_LARGE", message: "Images must be at most 4472 × 4472 pixels." };
  }
  const ratio = Math.max(info.width / info.height, info.height / info.width);
  if (ratio > MAX_ASPECT_RATIO) {
    return { ok: false, code: "INVALID_IMAGE", message: "The image is too narrow (aspect ratio must be within 100:1)." };
  }
  return { ok: true, mimeType: info.mimeType, width: info.width, height: info.height, size };
}
