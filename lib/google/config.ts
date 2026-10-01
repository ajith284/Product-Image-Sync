import "server-only";

/**
 * Central, server-only Google OAuth / Drive configuration.
 *
 * All values come from environment variables (see .env.example and
 * docs/google-drive-setup.md). None use the NEXT_PUBLIC_ prefix and this module
 * imports "server-only", so importing it from a Client Component fails the build.
 * Read it inside request handlers (not at module load) so the rest of the app
 * works before Google is configured.
 */

export const GOOGLE_OAUTH_CALLBACK_PATH = "/api/google/callback";

export const GOOGLE_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_DRIVE_SCOPES",
  "GOOGLE_TOKEN_ENCRYPTION_KEY",
] as const;

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/**
 * Drive scopes this app may request — exactly ONE of them.
 * - drive.readonly (default, recommended): read folders + image files the user
 *   already has, including images added later — needed for background sync.
 *   Restricted scope → Google verification + annual security assessment for a
 *   public production app.
 * - drive.file: only files/folders the user explicitly picks with Google Picker.
 *   Non-sensitive, but Google documents it as per-file access, so new images
 *   added to a folder later are not guaranteed to be visible to background sync.
 * Anything broader (drive, drive.metadata.readonly, …) is rejected.
 */
export const ALLOWED_DRIVE_SCOPES = [`${SCOPE_PREFIX}drive.readonly`, `${SCOPE_PREFIX}drive.file`] as const;
export type DriveScope = (typeof ALLOWED_DRIVE_SCOPES)[number];

/** Identity scopes (non-sensitive): who connected (stable id + email). */
export const IDENTITY_SCOPES = ["openid", `${SCOPE_PREFIX}userinfo.email`] as const;

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The single Drive scope (full URL). */
  driveScope: DriveScope;
  /** Everything requested at consent time: identity scopes + Drive scope. */
  requestScopes: string[];
  tokenEncryptionKey: Buffer;
};

type EnvName = (typeof GOOGLE_ENV_VARS)[number];
type Env = Partial<Record<EnvName, string | undefined>>;

export class GoogleConfigError extends Error {
  readonly missing: string[];
  readonly invalid: string[];
  constructor(missing: string[], invalid: string[]) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing ${missing.join(", ")}`);
    if (invalid.length) parts.push(`invalid ${invalid.join(", ")}`);
    super(
      `Google Drive is not configured: ${parts.join("; ")}. ` +
        "Set these server-side environment variables (see docs/google-drive-setup.md).",
    );
    this.name = "GoogleConfigError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

/** Accepts "drive.readonly" or the full URL; space- or comma-separated. */
export function parseDriveScopes(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("https://") ? s : `${SCOPE_PREFIX}${s.replace(/^auth\//, "")}`));
}

function parseRedirectUri(value: string, isProduction: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost && !isProduction)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname.replace(/\/+$/, "") !== GOOGLE_OAUTH_CALLBACK_PATH) return null;
  return `${url.origin}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

function parseEncryptionKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

function evaluate(env: Env, isProduction: boolean) {
  const missing: EnvName[] = [];
  const problems: { name: EnvName; reason: string }[] = [];
  const get = (name: EnvName) => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? "";
  };

  const clientId = get("GOOGLE_CLIENT_ID");
  const clientSecret = get("GOOGLE_CLIENT_SECRET");
  const redirectRaw = get("GOOGLE_REDIRECT_URI");
  const scopesRaw = get("GOOGLE_DRIVE_SCOPES");
  const keyRaw = get("GOOGLE_TOKEN_ENCRYPTION_KEY");

  if (clientId && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    problems.push({ name: "GOOGLE_CLIENT_ID", reason: "must end with .apps.googleusercontent.com" });
  }

  const redirectUri = redirectRaw ? parseRedirectUri(redirectRaw, isProduction) : null;
  if (redirectRaw && !redirectUri) {
    problems.push({
      name: "GOOGLE_REDIRECT_URI",
      reason: `must be ${isProduction ? "https://" : "https:// (or http://localhost)"}<your-app>${GOOGLE_OAUTH_CALLBACK_PATH}`,
    });
  }

  const scopes = scopesRaw ? parseDriveScopes(scopesRaw) : [];
  const driveScope =
    scopes.length === 1 && (ALLOWED_DRIVE_SCOPES as readonly string[]).includes(scopes[0]!)
      ? (scopes[0] as DriveScope)
      : null;
  if (scopesRaw && !driveScope) {
    problems.push({ name: "GOOGLE_DRIVE_SCOPES", reason: "must be exactly one of drive.readonly, drive.file" });
  }

  const tokenEncryptionKey = keyRaw ? parseEncryptionKey(keyRaw) : null;
  if (keyRaw && !tokenEncryptionKey) {
    problems.push({ name: "GOOGLE_TOKEN_ENCRYPTION_KEY", reason: "must be 32 random bytes, base64-encoded" });
  }

  const config: GoogleConfig | null =
    missing.length === 0 && problems.length === 0
      ? {
          clientId,
          clientSecret,
          redirectUri: redirectUri!,
          driveScope: driveScope!,
          requestScopes: [...IDENTITY_SCOPES, driveScope!],
          tokenEncryptionKey: tokenEncryptionKey!,
        }
      : null;
  return { config, missing, problems };
}

function readEnv(): Env {
  return Object.fromEntries(GOOGLE_ENV_VARS.map((name) => [name, process.env[name]]));
}

/**
 * Returns the validated config or throws GoogleConfigError naming every
 * missing/invalid variable (names only — never values).
 */
export function getGoogleConfig(env: Env = readEnv(), isProduction = process.env.NODE_ENV === "production"): GoogleConfig {
  const { config, missing, problems } = evaluate(env, isProduction);
  if (!config) throw new GoogleConfigError(missing, problems.map((p) => `${p.name} (${p.reason})`));
  return config;
}

/** Non-throwing status for readiness checks. Names only, never values. */
export function getGoogleConfigStatus(env: Env = readEnv(), isProduction = process.env.NODE_ENV === "production") {
  const { config, missing, problems } = evaluate(env, isProduction);
  return { configured: Boolean(config), missing, invalid: problems.map((p) => p.name) };
}
