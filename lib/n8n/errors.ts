/**
 * One consistent error format for /api/n8n/v1:
 *   { "error": { "code": "STORE_NOT_FOUND", "message": "…", "request_id": "…" } }
 * Messages are safe for automation logs: no stack traces, DB errors or secrets.
 */
export const N8N_API_ERRORS = {
  INVALID_API_KEY: { status: 401, message: "The API credential is missing, invalid, revoked or expired." },
  INVALID_SIGNATURE: { status: 401, message: "The request signature is invalid." },
  REQUEST_EXPIRED: { status: 401, message: "The request timestamp is missing or outside the allowed window." },
  REPLAYED_REQUEST: { status: 401, message: "This signed request was already used." },
  INSUFFICIENT_SCOPE: { status: 403, message: "The API credential doesn't have permission for this action." },
  STORE_NOT_FOUND: { status: 404, message: "The requested store was not found." },
  JOB_NOT_FOUND: { status: 404, message: "The requested sync job was not found." },
  NOT_FOUND: { status: 404, message: "Not found." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed." },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: "This Idempotency-Key was already used with a different request.",
  },
  SYNC_JOB_ALREADY_ACTIVE: { status: 409, message: "A sync job is already queued or running for this store." },
  JOB_NOT_CANCELLABLE: { status: 409, message: "This sync job has already finished and can't be cancelled." },
  SHOPIFY_NOT_CONNECTED: { status: 409, message: "Shopify isn't connected for this store." },
  GOOGLE_DRIVE_NOT_CONNECTED: { status: 409, message: "Google Drive isn't connected for this store." },
  GOOGLE_DRIVE_ROOT_NOT_SELECTED: { status: 409, message: "No Google Drive root folder is selected for this store." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The request body is too large." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Send the request body as application/json." },
  INVALID_JSON: { status: 400, message: "The request body isn't valid JSON." },
  INVALID_REQUEST: { status: 422, message: "The request is invalid." },
  IDEMPOTENCY_KEY_REQUIRED: { status: 422, message: "An Idempotency-Key header is required for this request." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Retry after the time in the Retry-After header." },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong. Please retry later." },
  NOT_CONFIGURED: { status: 503, message: "The API isn't configured on the server." },
} as const;

export type N8nErrorCode = keyof typeof N8N_API_ERRORS;

export class N8nApiError extends Error {
  readonly code: N8nErrorCode;
  readonly detailMessage?: string;
  readonly headers?: Record<string, string>;
  readonly extra?: Record<string, unknown>;
  constructor(
    code: N8nErrorCode,
    opts: { message?: string; headers?: Record<string, string>; extra?: Record<string, unknown> } = {},
  ) {
    super(code);
    this.name = "N8nApiError";
    this.code = code;
    this.detailMessage = opts.message;
    this.headers = opts.headers;
    this.extra = opts.extra;
  }
  get status() {
    return N8N_API_ERRORS[this.code].status;
  }
  get publicMessage() {
    return this.detailMessage ?? N8N_API_ERRORS[this.code].message;
  }
}

/** Database exception codes (raised by the n8n_* SQL functions) → API codes. */
export const SQL_ERROR_MAP: Record<string, N8nErrorCode> = {
  invalid_api_key: "INVALID_API_KEY",
  insufficient_scope: "INSUFFICIENT_SCOPE",
  store_not_found: "STORE_NOT_FOUND",
  job_not_found: "JOB_NOT_FOUND",
  invalid_request: "INVALID_REQUEST",
  idempotency_conflict: "IDEMPOTENCY_CONFLICT",
  sync_job_already_active: "SYNC_JOB_ALREADY_ACTIVE",
  job_not_cancellable: "JOB_NOT_CANCELLABLE",
  shopify_not_connected: "SHOPIFY_NOT_CONNECTED",
  google_drive_not_connected: "GOOGLE_DRIVE_NOT_CONNECTED",
  google_drive_root_not_selected: "GOOGLE_DRIVE_ROOT_NOT_SELECTED",
};
