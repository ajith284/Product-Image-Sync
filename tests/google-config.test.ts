import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ALLOWED_DRIVE_SCOPES,
  getGoogleConfig,
  getGoogleConfigStatus,
  GoogleConfigError,
  parseDriveScopes,
} from "@/lib/google/config";
import { GoogleFlowError } from "@/lib/google/errors";

const valid = {
  GOOGLE_CLIENT_ID: "123456789012-abcdefg.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-super-secret-value",
  GOOGLE_REDIRECT_URI: "https://app.example.com/api/google/callback",
  GOOGLE_DRIVE_SCOPES: "drive.readonly",
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
};

describe("getGoogleConfig", () => {
  it("builds the config; identity scopes + exactly one Drive scope", () => {
    const c = getGoogleConfig(valid, true);
    expect(c.driveScope).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(c.requestScopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
    expect(c.redirectUri).toBe("https://app.example.com/api/google/callback");
    expect(c.tokenEncryptionKey).toHaveLength(32);
  });

  it("missing variables → clear error naming every missing variable (names only)", () => {
    const err = (() => {
      try {
        getGoogleConfig({}, false);
      } catch (e) {
        return e as GoogleConfigError;
      }
    })()!;
    expect(err).toBeInstanceOf(GoogleConfigError);
    expect(err.missing).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "GOOGLE_DRIVE_SCOPES",
      "GOOGLE_TOKEN_ENCRYPTION_KEY",
    ]);
    expect(err.message).toContain("Google Drive is not configured: missing GOOGLE_CLIENT_ID");
    expect(err.message).toContain("docs/google-drive-setup.md");
  });

  it("one missing variable is reported by name, never echoing other values", () => {
    expect(() => getGoogleConfig({ ...valid, GOOGLE_CLIENT_SECRET: "" }, true)).toThrow(/missing GOOGLE_CLIENT_SECRET/);
    try {
      getGoogleConfig({ ...valid, GOOGLE_DRIVE_SCOPES: "drive" }, true);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(valid.GOOGLE_CLIENT_SECRET);
      expect(String((e as Error).message)).not.toContain(valid.GOOGLE_TOKEN_ENCRYPTION_KEY);
    }
  });

  it.each([
    ["full Drive access", "drive"],
    ["metadata of the whole Drive", "drive.metadata.readonly"],
    ["two Drive scopes", "drive.readonly drive.file"],
    ["unknown scope", "gmail.readonly"],
  ])("rejects broader or extra scopes: %s", (_label, scopes) => {
    expect(() => getGoogleConfig({ ...valid, GOOGLE_DRIVE_SCOPES: scopes }, true)).toThrow(
      /GOOGLE_DRIVE_SCOPES \(must be exactly one of drive.readonly, drive.file\)/,
    );
  });

  it("accepts drive.file as the narrow alternative (full URL form too)", () => {
    expect(getGoogleConfig({ ...valid, GOOGLE_DRIVE_SCOPES: "https://www.googleapis.com/auth/drive.file" }, true).driveScope).toBe(
      ALLOWED_DRIVE_SCOPES[1],
    );
  });

  it.each([
    ["wrong path", "https://app.example.com/api/shopify/callback"],
    ["http outside localhost", "http://app.example.com/api/google/callback"],
    ["query string", "https://app.example.com/api/google/callback?x=1"],
    ["not a URL", "callback"],
  ])("rejects redirect URI: %s", (_label, uri) => {
    expect(() => getGoogleConfig({ ...valid, GOOGLE_REDIRECT_URI: uri }, true)).toThrow(/GOOGLE_REDIRECT_URI/);
  });

  it("http://localhost redirect is allowed in development only", () => {
    const local = { ...valid, GOOGLE_REDIRECT_URI: "http://localhost:3000/api/google/callback" };
    expect(getGoogleConfig(local, false).redirectUri).toBe("http://localhost:3000/api/google/callback");
    expect(() => getGoogleConfig(local, true)).toThrow(/GOOGLE_REDIRECT_URI/);
  });

  it("rejects malformed client id and encryption key", () => {
    expect(() => getGoogleConfig({ ...valid, GOOGLE_CLIENT_ID: "my-client" }, true)).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() =>
      getGoogleConfig({ ...valid, GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }, true),
    ).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
  });

  it("status helper reports names only", () => {
    expect(getGoogleConfigStatus({ ...valid, GOOGLE_CLIENT_ID: "" }, true)).toEqual({
      configured: false,
      missing: ["GOOGLE_CLIENT_ID"],
      invalid: [],
    });
    expect(getGoogleConfigStatus(valid, true).configured).toBe(true);
  });

  it("parseDriveScopes expands shorthand", () => {
    expect(parseDriveScopes("drive.readonly, auth/drive.file")).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ]);
  });
});

describe("getGoogleDeps (missing configuration)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("becomes a friendly not_configured error; logs variable names only", async () => {
    for (const k of Object.keys(valid)) vi.stubEnv(k, "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "GOCSPX-should-never-be-logged");
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    const { getGoogleDeps } = await import("@/lib/google/runtime");
    let err: unknown;
    try {
      getGoogleDeps();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GoogleFlowError);
    expect((err as GoogleFlowError).userMessage).toBe(
      "Google Drive connection isn't set up yet. Please contact your administrator.",
    );
    expect(logs.join("\n")).toContain("missing GOOGLE_CLIENT_ID");
    expect(logs.join("\n")).not.toContain("GOCSPX-should-never-be-logged");
  });
});

describe("Google secrets never reach the browser (source checks)", () => {
  const root = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", ".next", ".git"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  for (const d of ["app", "components", "lib", "hooks"]) {
    try {
      walk(join(root, d));
    } catch {
      /* folder may not exist */
    }
  }

  it("no NEXT_PUBLIC_ Google variables anywhere", () => {
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/NEXT_PUBLIC_GOOGLE/);
  });

  it("server-only Google modules import 'server-only'", () => {
    for (const f of files.filter((f) => /lib[\\/]google[\\/](?!errors)/.test(f))) {
      expect(readFileSync(f, "utf8"), f).toMatch(/^import "server-only";/);
    }
  });

  it("client components never import Google server modules", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.startsWith('"use client"')) continue;
      expect(src, f).not.toMatch(/@\/lib\/google\/(config|auth|connection|tokens|crypto|repository|runtime|client)"/);
    }
  });
});
