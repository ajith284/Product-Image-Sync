import "server-only";

import { ALLOWED_SHOPIFY_SCOPES, parseScopes, REQUIRED_SHOPIFY_SCOPES } from "@/lib/shopify/scopes";
import type { ShopifyConfig, ShopifyConfigStatus } from "@/lib/shopify/types";

/**
 * Central, server-only Shopify app configuration.
 *
 * All values come from environment variables (see .env.example and
 * docs/shopify-setup.md). None of them use the NEXT_PUBLIC_ prefix, and this
 * module imports "server-only", so importing it from a Client Component fails
 * the build.
 */

/** Paths of this app's OAuth routes (implemented in the next phase). */
export const SHOPIFY_OAUTH_START_PATH = "/api/shopify/auth";
export const SHOPIFY_OAUTH_CALLBACK_PATH = "/api/shopify/callback";

export const SHOPIFY_ENV_VARS = [
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_APP_URL",
  "SHOPIFY_SCOPES",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_TOKEN_ENCRYPTION_KEY",
] as const;

type EnvName = (typeof SHOPIFY_ENV_VARS)[number];
type Env = Partial<Record<EnvName, string | undefined>>;

const API_VERSION_RE = /^\d{4}-(01|04|07|10)$/;

export class ShopifyConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];
  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing ${missing.join(", ")}`);
    if (invalid.length) parts.push(`invalid ${invalid.join(", ")}`);
    super(
      `Shopify is not configured: ${parts.join("; ")}. ` +
        "Set these server-side environment variables (see docs/shopify-setup.md).",
    );
    this.name = "ShopifyConfigError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

/** Reasons are for developers; they name variables, never echo values. */
type Problem = { name: EnvName; reason: string };

function parseAppUrl(value: string, isProduction: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost && !isProduction)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function parseEncryptionKey(value: string): Buffer | null {
  // 32 random bytes, base64-encoded (e.g. `openssl rand -base64 32`).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

function evaluate(env: Env, isProduction: boolean) {
  const missing: EnvName[] = [];
  const problems: Problem[] = [];
  const get = (name: EnvName) => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? "";
  };

  const clientId = get("SHOPIFY_CLIENT_ID");
  const clientSecret = get("SHOPIFY_CLIENT_SECRET");
  const appUrlRaw = get("SHOPIFY_APP_URL");
  const scopesRaw = get("SHOPIFY_SCOPES");
  const apiVersion = get("SHOPIFY_API_VERSION");
  const keyRaw = get("SHOPIFY_TOKEN_ENCRYPTION_KEY");

  const appUrl = appUrlRaw ? parseAppUrl(appUrlRaw, isProduction) : null;
  if (appUrlRaw && !appUrl) {
    problems.push({
      name: "SHOPIFY_APP_URL",
      reason: isProduction ? "must be an https:// URL" : "must be an https:// URL or http://localhost",
    });
  }

  const scopes = scopesRaw ? parseScopes(scopesRaw) : [];
  if (scopesRaw) {
    const notAllowed = scopes.filter((s) => !ALLOWED_SHOPIFY_SCOPES.includes(s));
    const absent = REQUIRED_SHOPIFY_SCOPES.filter((s) => !scopes.includes(s));
    if (notAllowed.length || absent.length) {
      problems.push({
        name: "SHOPIFY_SCOPES",
        reason: `must be exactly ${REQUIRED_SHOPIFY_SCOPES.join(",")}`,
      });
    }
  }

  if (apiVersion && !API_VERSION_RE.test(apiVersion)) {
    problems.push({ name: "SHOPIFY_API_VERSION", reason: "must be a stable version like 2026-07" });
  }

  const tokenEncryptionKey = keyRaw ? parseEncryptionKey(keyRaw) : null;
  if (keyRaw && !tokenEncryptionKey) {
    problems.push({ name: "SHOPIFY_TOKEN_ENCRYPTION_KEY", reason: "must be 32 random bytes, base64-encoded" });
  }

  const config: ShopifyConfig | null =
    missing.length === 0 && problems.length === 0
      ? {
          clientId,
          clientSecret,
          appUrl: appUrl!,
          redirectUri: `${appUrl}${SHOPIFY_OAUTH_CALLBACK_PATH}`,
          scopes,
          apiVersion,
          tokenEncryptionKey: tokenEncryptionKey!,
        }
      : null;

  return { config, missing, problems };
}

function readEnv(): Env {
  return Object.fromEntries(SHOPIFY_ENV_VARS.map((name) => [name, process.env[name]]));
}

/**
 * Returns the validated config or throws ShopifyConfigError naming every
 * missing/invalid variable. Call it inside request handlers (not at module
 * load) so the rest of the app works before Shopify is configured.
 */
export function getShopifyConfig(env: Env = readEnv(), isProduction = process.env.NODE_ENV === "production"): ShopifyConfig {
  const { config, missing, problems } = evaluate(env, isProduction);
  if (!config) {
    throw new ShopifyConfigError(
      missing,
      problems.map((p) => `${p.name} (${p.reason})`),
    );
  }
  return config;
}

/** Non-throwing status for readiness checks. Contains names only, never values. */
export function getShopifyConfigStatus(
  env: Env = readEnv(),
  isProduction = process.env.NODE_ENV === "production",
): ShopifyConfigStatus {
  const { config, missing, problems } = evaluate(env, isProduction);
  return { configured: Boolean(config), missing, invalid: problems.map((p) => p.name) };
}
