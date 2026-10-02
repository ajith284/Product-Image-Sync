import "server-only";

import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { NextResponse, type NextRequest } from "next/server";

import { readLimitedBody } from "@/lib/http/limited-body";
import { N8nApiError, type N8nErrorCode } from "@/lib/n8n/errors";
import { canonicalString, parseApiToken, safeEqualHex, sha256Hex, verifySignature, type ApiScope } from "@/lib/n8n/keys";
import type { N8nRepository, StoredApiKey } from "@/lib/n8n/repository";
import { getN8nRepository } from "@/lib/n8n/runtime";

/**
 * Shared wrapper for every /api/n8n/v1 endpoint:
 *   request id → body limits → API key (Bearer) → optional HMAC signature
 *   (+ timestamp window + nonce replay check) → scope → rate limits → handler
 *   → consistent JSON + X-Request-ID → one structured audit log line.
 * Browser cookies/sessions are never consulted.
 */

export const MAX_BODY_BYTES = 16 * 1024;
export const SIGNATURE_WINDOW_SECONDS = 300;
export const NONCE_TTL_SECONDS = 600;
/** Per API key per minute; per workspace per minute; failed auth per IP per minute. */
export const RATE_LIMITS = { read: 120, write: 30, workspace: 600, authFailuresPerIp: 20 } as const;
const WINDOW_SECONDS = 60;

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;

export type N8nContext = {
  requestId: string;
  key: StoredApiKey;
  repo: N8nRepository;
  rawBody: string;
  url: URL;
  headers: Headers;
};

export type N8nResult = { status?: number; body: unknown; headers?: Record<string, string> };

type Options = { scope: ApiScope; rate: "read" | "write" };

/**
 * Client IP for the failed-auth throttle (Prompt 14D).
 *
 * Trust boundary: the app is reached through N8N_TRUSTED_PROXY_HOPS proxies (default 1)
 * that APPEND the connecting client's address to X-Forwarded-For — ngrok appends (its
 * docs: "use the last value of the header"); Vercel overwrites the header with the client
 * IP, so the last value is also correct there. Entries further left were written by the
 * caller and are ignored: using the first entry let an attacker reset the throttle on
 * every request. X-Real-IP is ignored for the same reason (client-settable unless a proxy
 * sets it). No header → one shared "direct" bucket. Values are validated as IPs so a
 * header can't create arbitrary bucket keys.
 */
export function clientIp(headers: Headers): string {
  const hops = Math.min(Math.max(Number.parseInt(process.env.N8N_TRUSTED_PROXY_HOPS ?? "1", 10) || 1, 1), 10);
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!parts.length) return "direct";
  let ip = parts[Math.max(0, parts.length - hops)]!;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip); // [IPv6]:port
  if (bracketed) ip = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":")); // IPv4:port
  return isIP(ip) ? ip.toLowerCase() : "invalid";
}

export function resolveRequestId(request: Request): { id: string; fromClient: boolean } {
  const given = request.headers.get("x-request-id");
  return given && REQUEST_ID_RE.test(given) ? { id: given, fromClient: true } : { id: `req_${randomUUID()}`, fromClient: false };
}

export function jsonResponse(requestId: string, status: number, body: unknown, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers },
  });
}

export function errorResponse(requestId: string, error: N8nApiError) {
  return jsonResponse(
    requestId,
    error.status,
    { error: { code: error.code, message: error.publicMessage, request_id: requestId, ...(error.extra ?? {}) } },
    error.headers,
  );
}

function audit(entry: Record<string, unknown>) {
  // One line per request. Never includes the Authorization header, secrets or bodies.
  console.info(JSON.stringify({ event: "n8n_api", ...entry }));
}

async function rateLimit(repo: N8nRepository, bucket: string, limit: number) {
  const r = await repo.rateLimit(bucket, limit, WINDOW_SECONDS);
  if (!r.allowed) throw new N8nApiError("RATE_LIMITED", { headers: { "Retry-After": String(r.retryAfter) } });
}

async function authenticate(request: NextRequest, repo: N8nRepository): Promise<StoredApiKey> {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  const parsed = m ? parseApiToken(m[1]!) : null;
  const key = parsed ? await repo.authenticate(parsed.prefix) : null;
  if (!parsed || !key || !safeEqualHex(sha256Hex(parsed.secret), key.secretHash)) {
    // Throttle credential guessing per client IP.
    await rateLimit(repo, `authfail:${clientIp(request.headers)}`, RATE_LIMITS.authFailuresPerIp);
    throw new N8nApiError("INVALID_API_KEY");
  }
  return key;
}

async function checkSignature(
  request: NextRequest,
  key: StoredApiKey,
  repo: N8nRepository,
  rawBody: string,
  requestId: { id: string; fromClient: boolean },
) {
  const signature = request.headers.get("x-pis-signature");
  const required = process.env.N8N_API_REQUIRE_SIGNATURE === "true";
  if (!signature && !required) return;
  if (!signature) throw new N8nApiError("INVALID_SIGNATURE", { message: "This API requires signed requests." });

  const ts = request.headers.get("x-pis-timestamp") ?? "";
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d{9,11}$/.test(ts) || Math.abs(now - Number(ts)) > SIGNATURE_WINDOW_SECONDS) {
    throw new N8nApiError("REQUEST_EXPIRED");
  }
  if (!requestId.fromClient) {
    throw new N8nApiError("INVALID_SIGNATURE", { message: "Signed requests must send a unique X-Request-ID (8-100 chars)." });
  }
  const url = new URL(request.url);
  const canonical = canonicalString({
    timestamp: ts,
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    body: rawBody,
    requestId: requestId.id,
  });
  // Signing key = SHA-256(secret) hex (shown once at creation; equals the stored hash).
  if (!verifySignature(key.secretHash, canonical, signature)) throw new N8nApiError("INVALID_SIGNATURE");
  if (!(await repo.useNonce(key.id, requestId.id, NONCE_TTL_SECONDS))) throw new N8nApiError("REPLAYED_REQUEST");
}

async function readBody(request: NextRequest): Promise<string> {
  if (request.method === "GET" || request.method === "HEAD") return "";
  // Bounded read (Prompt 14D): Content-Length AND the actual stream are limited, so a
  // missing / chunked / lying Content-Length can't make us buffer a large body before auth.
  const read = await readLimitedBody(request, MAX_BODY_BYTES);
  if (!read.ok) throw new N8nApiError(read.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST");
  const text = read.body.toString("utf8");
  if (text && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new N8nApiError("UNSUPPORTED_MEDIA_TYPE");
  }
  return text;
}

export function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new N8nApiError("INVALID_JSON");
  }
}

export function n8nRoute<P extends Record<string, string> = Record<string, never>>(
  route: string,
  options: Options,
  fn: (ctx: N8nContext, params: P) => Promise<N8nResult>,
) {
  return async (request: NextRequest, context?: { params?: Promise<P> }) => {
    const started = Date.now();
    const rid = resolveRequestId(request);
    let key: StoredApiKey | null = null;
    let status = 500;
    let code: N8nErrorCode | null = null;
    try {
      const repo = getN8nRepository();
      const rawBody = await readBody(request);
      key = await authenticate(request, repo);
      await checkSignature(request, key, repo, rawBody, rid);
      if (!key.scopes.includes(options.scope)) throw new N8nApiError("INSUFFICIENT_SCOPE");
      await rateLimit(repo, `key:${key.id}:${options.rate}`, RATE_LIMITS[options.rate]);
      await rateLimit(repo, `ws:${key.workspaceId}`, RATE_LIMITS.workspace);
      void repo.touch(key.id).catch(() => undefined);

      const params = ((await context?.params) ?? {}) as P;
      const result = await fn(
        { requestId: rid.id, key, repo, rawBody, url: new URL(request.url), headers: request.headers },
        params,
      );
      status = result.status ?? 200;
      return jsonResponse(rid.id, status, result.body, result.headers);
    } catch (error) {
      const apiError =
        error instanceof N8nApiError
          ? error
          : error instanceof Error && error.name === "AdminClientConfigError"
            ? new N8nApiError("NOT_CONFIGURED")
            : new N8nApiError("INTERNAL_ERROR");
      if (!(error instanceof N8nApiError)) {
        console.error(`[n8n-api] ${route} ${rid.id}: ${error instanceof Error ? error.name : "unknown error"}`);
      }
      status = apiError.status;
      code = apiError.code;
      return errorResponse(rid.id, apiError);
    } finally {
      audit({
        request_id: rid.id,
        api_key_id: key?.id ?? null,
        workspace_id: key?.workspaceId ?? null,
        method: request.method,
        route,
        status,
        code,
        duration_ms: Date.now() - started,
      });
    }
  };
}
