/**
 * Error codes for the Shopify connection flow and their customer-facing
 * messages. Pure module: safe for client components (no secrets, no server deps).
 */
export const SHOPIFY_FLOW_MESSAGES = {
  not_configured: "Shopify connection isn't set up yet. Please contact your administrator.",
  forbidden: "Only workspace owners and admins can connect Shopify.",
  store_not_found: "We couldn't find this store in your workspace.",
  invalid_shop_domain: "This store's Shopify address isn't valid. It must end in .myshopify.com.",
  shop_connected_elsewhere: "This Shopify store is already connected in another workspace.",
  invalid_request: "The response from Shopify was incomplete. Please try connecting again.",
  invalid_hmac: "We couldn't verify the response from Shopify. Please try connecting again.",
  stale_request: "The Shopify response expired. Please try connecting again.",
  invalid_state: "This connection link isn't valid. Please start again from your store page.",
  expired_state: "The connection took too long. Please try again.",
  reused_state: "This connection link was already used. Please start again from your store page.",
  session_mismatch: "Please sign in with the account that started the Shopify connection, then try again.",
  shop_mismatch: "You approved a different Shopify store than the one saved for this store. Please try again.",
  exchange_failed: "Shopify didn't complete the connection. Please try again.",
  missing_scopes: "Shopify didn't grant all required permissions. Please reconnect and approve all permissions.",
  store_mismatch: "This store changed while connecting. Please try again.",
  not_connected: "Shopify isn't connected for this store.",
  needs_reconnect: "Shopify needs to be reconnected.",
  verify_failed: "We couldn't verify the Shopify connection. Please try again shortly.",
  unknown: "Something went wrong while connecting Shopify. Please try again.",
} as const;

export type ShopifyFlowErrorCode = keyof typeof SHOPIFY_FLOW_MESSAGES;

export function isShopifyFlowErrorCode(value: unknown): value is ShopifyFlowErrorCode {
  return typeof value === "string" && value in SHOPIFY_FLOW_MESSAGES;
}

export class ShopifyFlowError extends Error {
  readonly code: ShopifyFlowErrorCode;
  /** Store to return the user to, when known. */
  readonly storeId?: string;
  constructor(code: ShopifyFlowErrorCode, opts: { storeId?: string; cause?: unknown } = {}) {
    super(`Shopify flow error: ${code}`);
    this.name = "ShopifyFlowError";
    this.code = code;
    this.storeId = opts.storeId;
  }
  get userMessage() {
    return SHOPIFY_FLOW_MESSAGES[this.code];
  }
}
