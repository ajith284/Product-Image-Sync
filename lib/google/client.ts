import "server-only";

/**
 * Minimal, server-only Google Drive API v3 client (read-only GET requests).
 *
 * - Create it per request/job with an access token from refreshGoogleToken()
 *   (lib/google/connection.ts); never cache globally, never pass to the browser.
 * - Errors never contain the access token or response bodies.
 * - Folder listing, file download and image scanning are NOT implemented here
 *   (Prompt 7 builds them on top of `get()`).
 */

export const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DEFAULT_TIMEOUT_MS = 30_000;

export type DriveApiErrorKind =
  | "unauthorized" // 401: token expired/revoked
  | "insufficient_scope" // 403 insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT
  | "api_disabled" // 403 accessNotConfigured / SERVICE_DISABLED (Drive API not enabled)
  | "forbidden" // other 403 (no access to that file)
  | "not_found"
  | "throttled" // 429 or 403 rate limits
  | "unavailable" // 5xx
  | "network"
  | "bad_request";

const USER_MESSAGES: Record<DriveApiErrorKind, string> = {
  unauthorized: "Google Drive needs to be reconnected.",
  insufficient_scope: "Google Drive needs to be reconnected with Drive access allowed.",
  api_disabled: "Google Drive isn't enabled for this app yet. Please contact your administrator.",
  forbidden: "This Google account can't access that Drive item.",
  not_found: "We couldn't find that item in Google Drive.",
  throttled: "Google Drive is busy right now. We'll try again shortly.",
  unavailable: "Google Drive is temporarily unavailable. We'll try again shortly.",
  network: "We couldn't reach Google Drive. We'll try again shortly.",
  bad_request: "Google Drive rejected the request.",
};

export class DriveApiError extends Error {
  readonly kind: DriveApiErrorKind;
  readonly status?: number;
  constructor(kind: DriveApiErrorKind, detail: string, status?: number) {
    super(`Drive API ${kind}: ${detail}`);
    this.name = "DriveApiError";
    this.kind = kind;
    this.status = status;
  }
  get userMessage() {
    return USER_MESSAGES[this.kind];
  }
  get retryable() {
    return this.kind === "throttled" || this.kind === "unavailable" || this.kind === "network";
  }
}

function reasonOf(body: unknown): string {
  const err = (body as { error?: { errors?: { reason?: string }[]; status?: string; details?: { reason?: string }[] } })?.error;
  return [err?.errors?.[0]?.reason, err?.status, err?.details?.find((d) => d.reason)?.reason].filter(Boolean).join(" ");
}

function classify(status: number, body: unknown): DriveApiErrorKind {
  const reason = reasonOf(body);
  if (status === 401) return "unauthorized";
  if (status === 429 || /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT/i.test(reason)) return "throttled";
  if (status === 403) {
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason)) return "api_disabled";
    if (/insufficientPermissions|SCOPE_INSUFFICIENT|insufficient/i.test(reason)) return "insufficient_scope";
    return "forbidden";
  }
  if (status === 404) return "not_found";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

export type DriveClientOptions = {
  accessToken: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type DriveClient = {
  /** GET {DRIVE_API_BASE}/{path}?{query} — path like "about" or "files/{id}". */
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  /** Read-only check used for verification: who is connected. */
  getAbout(): Promise<{ emailAddress: string | null; displayName: string | null }>;
};

export function createDriveClient(options: DriveClientOptions): DriveClient {
  if (!options.accessToken) throw new Error("createDriveClient: accessToken is required");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    if (!/^[A-Za-z0-9/_-]+$/.test(path) || path.includes("..")) throw new Error("createDriveClient: invalid path");
    const url = new URL(`${DRIVE_API_BASE}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      throw new DriveApiError("network", `request failed (${error instanceof Error ? error.name : "unknown"})`);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw new DriveApiError(classify(res.status, body), `HTTP ${res.status}`, res.status);
    if (body === null) throw new DriveApiError("unavailable", "invalid JSON", res.status);
    return body as T;
  }

  return {
    get,
    async getAbout() {
      const data = await get<{ user?: { emailAddress?: string; displayName?: string } }>("about", {
        fields: "user(emailAddress,displayName)",
      });
      return { emailAddress: data.user?.emailAddress ?? null, displayName: data.user?.displayName ?? null };
    },
  };
}
