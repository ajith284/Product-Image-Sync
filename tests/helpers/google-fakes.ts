import { vi } from "vitest";

import type { GoogleConfig } from "@/lib/google/config";
import type {
  ConsumedGoogleState,
  GoogleRepository,
  SaveGoogleConnectionInput,
  StoredGoogleCredentials,
} from "@/lib/google/repository";

export const G_STORE_ID = "44444444-4444-4444-8444-444444444444";
export const G_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
export const G_USER_ID = "66666666-6666-4666-8666-666666666666";
export const G_NOW = 1_790_000_000_000;

export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
export const ACCESS = "ya29.ACCESS_SECRET_1";
export const REFRESH = "1//REFRESH_SECRET_1";

export const googleConfig: GoogleConfig = {
  clientId: "123456789012-abcdefg.apps.googleusercontent.com",
  clientSecret: "GOCSPX-test-client-secret",
  redirectUri: "http://localhost:3000/api/google/callback",
  driveScope: DRIVE_READONLY,
  requestScopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", DRIVE_READONLY],
  tokenEncryptionKey: Buffer.alloc(32, 7),
};

/** Unsigned JWT-shaped ID token (tests only). */
export function idToken(claims: Record<string, unknown> = {}) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    enc({ alg: "RS256", typ: "JWT" }),
    enc({
      iss: "https://accounts.google.com",
      aud: googleConfig.clientId,
      sub: "google-sub-123",
      email: "owner@gmail.com",
      email_verified: true,
      exp: Math.floor(G_NOW / 1000) + 3600,
      ...claims,
    }),
    "signature",
  ].join(".");
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const tokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: ACCESS,
  expires_in: 3599,
  refresh_token: REFRESH,
  scope: `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_READONLY}`,
  token_type: "Bearer",
  id_token: idToken(),
  ...overrides,
});

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** fetch mock routing Google's token, revoke and Drive endpoints. */
export function googleFetch(routes: { token?: Handler; revoke?: Handler; drive?: Handler }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token" && routes.token) return routes.token(url, init ?? {});
    if (url.href === "https://oauth2.googleapis.com/revoke" && routes.revoke) return routes.revoke(url, init ?? {});
    if (url.href.startsWith("https://www.googleapis.com/drive/v3/") && routes.drive) return routes.drive(url, init ?? {});
    throw new Error(`unexpected fetch ${url.href}`);
  });
}

export const aboutOk = (email = "owner@gmail.com") => json({ user: { emailAddress: email, displayName: "Owner" } });

/** In-memory repository mirroring the SQL functions' semantics. */
export function fakeGoogleRepo(overrides: Partial<GoogleRepository> = {}) {
  const state: {
    consumed: ConsumedGoogleState;
    begun: { userId: string; storeId: string; stateHash: string; ttlSeconds: number }[];
    saved: SaveGoogleConnectionInput | null;
    creds: StoredGoogleCredentials | null;
    verifications: Parameters<GoogleRepository["recordVerification"]>[0][];
    disconnected: number;
    /** The ONE connection row's root folder (updates replace it; nothing is ever inserted). */
    root: { id: string; name: string } | null;
    rootUpdates: number;
  } = {
    consumed: { status: "ok", userId: G_USER_ID, workspaceId: G_WORKSPACE_ID, storeId: G_STORE_ID },
    begun: [],
    saved: null,
    creds: null,
    verifications: [],
    disconnected: 0,
    root: null,
    rootUpdates: 0,
  };

  const repo: GoogleRepository = {
    beginOAuth: vi.fn(async (input) => {
      state.begun.push(input);
      return input.storeId;
    }),
    consumeState: vi.fn(async () => state.consumed),
    saveConnection: vi.fn(async (input: SaveGoogleConnectionInput) => {
      state.saved = input;
      state.creds = {
        connectionId: "gconn-1",
        workspaceId: input.workspaceId,
        googleAccountId: input.googleAccountId,
        connectionStatus: "pending",
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken ?? state.creds?.encryptedRefreshToken ?? null,
        tokenExpiresAt: input.accessExpiresAt,
        tokenVersion: (state.creds?.tokenVersion ?? 0) + 1,
        accountShared: false,
      };
      return "gconn-1";
    }),
    getCredentials: vi.fn(async () => state.creds),
    storeRefreshedTokens: vi.fn(async (input) => {
      if (!state.creds || state.creds.tokenVersion !== input.expectedVersion) return false;
      state.creds = {
        ...state.creds,
        encryptedAccessToken: input.encryptedAccessToken,
        encryptedRefreshToken: input.encryptedRefreshToken ?? state.creds.encryptedRefreshToken,
        tokenExpiresAt: input.accessExpiresAt,
        tokenVersion: state.creds.tokenVersion + 1,
      };
      return true;
    }),
    recordVerification: vi.fn(async (input) => {
      state.verifications.push(input);
    }),
    disconnect: vi.fn(async () => {
      state.disconnected += 1;
      state.creds = null;
      return true;
    }),
    setRootFolder: vi.fn(async (input) => {
      // Mirrors: UPDATE … WHERE store_id AND google_account_id AND connection_status = 'connected'
      if (!state.creds || state.creds.connectionStatus !== "connected" || state.creds.googleAccountId !== input.googleAccountId) {
        return false;
      }
      state.root = { id: input.folderId, name: input.folderName };
      state.rootUpdates += 1;
      return true;
    }),
    ...overrides,
  };
  return { repo, state };
}
