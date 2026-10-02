import "server-only";

/**
 * Bounded request-body reader shared by the public machine endpoints (Shopify webhooks,
 * /api/n8n/v1). Returns the RAW bytes (needed for HMAC checks) and never holds more than
 * `maxBytes` (+ at most one in-flight chunk) in memory:
 *   1. a declared Content-Length above the limit → 413 without reading anything;
 *      a malformed Content-Length → 400 without reading anything;
 *   2. the stream itself is counted chunk by chunk, so a missing, chunked or lying
 *      Content-Length is bounded too — the stream is cancelled as soon as it goes over.
 * An upload that breaks mid-stream → 400. The bytes are never logged or echoed.
 *
 * Why not rely on Next.js: the proxy's body buffer (proxyClientMaxBodySize, default 10 MB)
 * silently TRUNCATES instead of rejecting, and route handlers have no body limit at all.
 */
export type LimitedBody =
  { ok: true; body: Buffer } | { ok: false; status: 400 | 413 };

export async function readLimitedBody(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<LimitedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) {
      await request.body?.cancel().catch(() => undefined);
      return { ok: false, status: 400 };
    }
    if (Number(declared) > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
  }
  if (!request.body) return { ok: true, body: Buffer.alloc(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 }; // aborted / broken upload
  } finally {
    reader.releaseLock();
  }
  return { ok: true, body: Buffer.concat(chunks, total) };
}
