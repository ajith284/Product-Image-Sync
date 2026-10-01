/**
 * Error codes for the Google Drive connection flow and their customer-facing
 * messages. Pure module: safe for client components (no secrets, no server deps).
 */
export const GOOGLE_FLOW_MESSAGES = {
  not_configured: "Google Drive connection isn't set up yet. Please contact your administrator.",
  forbidden: "Only workspace owners and admins can connect Google Drive.",
  store_not_found: "We couldn't find this store in your workspace.",
  store_mismatch: "This store changed while connecting. Please try again.",
  invalid_request: "The response from Google was incomplete. Please try connecting again.",
  invalid_state: "This connection link isn't valid. Please start again from your store page.",
  expired_state: "The connection took too long. Please try again.",
  reused_state: "This connection link was already used. Please start again from your store page.",
  session_mismatch: "Please sign in with the account that started the Google Drive connection, then try again.",
  access_denied: "Google Drive access wasn't granted. Connect again and allow access to continue.",
  provider_error: "Google couldn't complete the connection. Please try again.",
  exchange_failed: "Google didn't complete the connection. Please try again.",
  missing_scopes: "Please allow access to Google Drive when Google asks, then try again.",
  missing_refresh_token: "Google didn't grant ongoing access. Please connect again.",
  invalid_identity: "We couldn't confirm your Google account. Please try again.",
  not_connected: "Google Drive isn't connected for this store.",
  needs_reconnect: "Google Drive needs to be reconnected.",
  drive_api_disabled: "Google Drive isn't enabled for this app yet. Please contact your administrator.",
  verify_failed: "We couldn't verify the Google Drive connection. Please try again shortly.",
  unknown: "Something went wrong while connecting Google Drive. Please try again.",
} as const;

export type GoogleFlowErrorCode = keyof typeof GOOGLE_FLOW_MESSAGES;

export function isGoogleFlowErrorCode(value: unknown): value is GoogleFlowErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_FLOW_MESSAGES, value);
}

export class GoogleFlowError extends Error {
  readonly code: GoogleFlowErrorCode;
  /** Store to return the user to, when known. */
  readonly storeId?: string;
  constructor(code: GoogleFlowErrorCode, opts: { storeId?: string } = {}) {
    super(`Google flow error: ${code}`);
    this.name = "GoogleFlowError";
    this.code = code;
    this.storeId = opts.storeId;
  }
  get userMessage() {
    return GOOGLE_FLOW_MESSAGES[this.code];
  }
}
