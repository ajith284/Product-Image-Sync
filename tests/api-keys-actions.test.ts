import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseApiToken, sha256Hex } from "@/lib/n8n/keys";
import { fakeN8n, STORE_A, STORE_B, WS_A, WS_B } from "./helpers/fake-n8n";

/**
 * Prompt 14C — API key management server actions (app/(app)/settings/api-keys/actions.ts)
 * and lib/api-keys/service.ts. The service-role RPCs are faked in memory with the same
 * rules as supabase/migrations/*_n8n_api.sql (api_key_create / api_key_revoke /
 * api_keys_list) and share their key store with the n8n API fake, so "revoked → cannot
 * authenticate" is checked through the real n8n route handler. No real keys, no network.
 */

const OWNER = "a0000000-0000-4000-8000-00000000000a";
const ADMIN = "a0000000-0000-4000-8000-0000000000ad";
const MEMBER = "a0000000-0000-4000-8000-0000000000ee";
const OWNER_B = "b0000000-0000-4000-8000-00000000000b";
const DB_LEAK =
  'duplicate key value violates unique constraint "api_keys_secret_hash_key" DETAIL: Key (secret_hash)=(deadbeef)';

type Role = "owner" | "admin" | "member";
const MEMBERSHIPS: { user: string; ws: string; role: Role }[] = [
  { user: OWNER, ws: WS_A, role: "owner" },
  { user: ADMIN, ws: WS_A, role: "admin" },
  { user: MEMBER, ws: WS_A, role: "member" },
  { user: OWNER_B, ws: WS_B, role: "owner" },
];

const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  env: null as unknown,
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcOverride: null as
    | null
    | ((
        fn: string,
      ) => { data: unknown; error: { message: string } | null } | undefined),
  listExtraColumns: false,
  adminThrows: null as Error | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace")>();
  return {
    ...actual,
    requireWorkspace: vi.fn(async () => {
      if (!mocks.ctx) {
        const { redirect } = await import("next/navigation");
        redirect("/login");
      }
      return mocks.ctx;
    }),
  };
});
vi.mock("@/lib/n8n/runtime", () => ({
  getN8nRepository: () => (mocks.env as ReturnType<typeof fakeN8n>).repo,
}));

// Fake service-role client: same checks as the SQL functions (is_workspace_manager, store ∈ workspace, …).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (mocks.adminThrows) throw mocks.adminThrows;
    return {
      async rpc(fn: string, args: Record<string, unknown>) {
        mocks.rpcCalls.push({ fn, args });
        const forced = mocks.rpcOverride?.(fn);
        if (forced) return forced;
        const env = mocks.env as ReturnType<typeof fakeN8n>;
        const manager = (user: unknown, ws: unknown) =>
          MEMBERSHIPS.some(
            (m) =>
              m.user === user &&
              m.ws === ws &&
              (m.role === "owner" || m.role === "admin"),
          );
        const fail = (message: string) => ({ data: null, error: { message } });
        if (fn === "api_key_create") {
          if (!manager(args.p_user_id, args.p_workspace_id))
            return fail("forbidden");
          if (
            args.p_store_id &&
            !env.stores.some(
              (s) =>
                s.id === args.p_store_id &&
                s.workspaceId === args.p_workspace_id,
            )
          ) {
            return fail("store_not_found");
          }
          if (!/^[0-9a-f]{64}$/.test(String(args.p_secret_hash)))
            return fail("invalid_request");
          if (
            env.keys.filter(
              (k) => k.workspaceId === args.p_workspace_id && !k.revoked,
            ).length >= 25
          )
            return fail("too_many_keys");
          const id = crypto.randomUUID();
          env.keys.push({
            id,
            prefix: String(args.p_key_prefix),
            workspaceId: String(args.p_workspace_id),
            storeId: (args.p_store_id as string | null) ?? null,
            scopes: args.p_scopes as never,
            secretHash: String(args.p_secret_hash),
            name: String(args.p_name),
            revoked: false,
          });
          return { data: id, error: null };
        }
        if (fn === "api_key_revoke") {
          const k = env.keys.find((x) => x.id === args.p_key_id);
          if (!k || !manager(args.p_user_id, k.workspaceId))
            return fail("not_found");
          if (k.revoked) return { data: false, error: null };
          k.revoked = true;
          return { data: true, error: null };
        }
        if (fn === "api_keys_list") {
          if (!manager(args.p_user_id, args.p_workspace_id))
            return fail("forbidden");
          const rows = env.keys
            .filter((k) => k.workspaceId === args.p_workspace_id)
            .map((k) => ({
              id: k.id,
              name: k.name,
              key_prefix: k.prefix,
              store_id: k.storeId,
              store_name: null,
              scopes: k.scopes,
              created_at: "2026-10-02T00:00:00Z",
              last_used_at: null,
              expires_at: null,
              revoked_at: k.revoked ? "2026-10-02T01:00:00Z" : null,
              // A future SQL change that accidentally returns the hash must still not reach the UI.
              ...(mocks.listExtraColumns
                ? {
                    secret_hash: k.secretHash,
                    token: "pis_live_SHOULD_NOT_APPEAR",
                  }
                : {}),
            }));
          return { data: rows, error: null };
        }
        return fail("unknown_function");
      },
    };
  },
}));

const actions = await import("@/app/(app)/settings/api-keys/actions");
const service = await import("@/lib/api-keys/service");
const statusRoute =
  await import("@/app/api/n8n/v1/stores/[storeId]/status/route");

/** The secret part of a token (base64url may itself contain "_", so use the real parser). */
const secretOf = (token: string) => parseApiToken(token)!.secret;

let env: ReturnType<typeof fakeN8n>;
let logs: string[];

function ctxFor(user: string, ws: string, role: Role) {
  return {
    user: { id: user, email: "u@example.com", fullName: "U" },
    memberships: [{ workspaceId: ws, workspaceName: "WS", role }],
    workspace: { workspaceId: ws, workspaceName: "WS", role },
  };
}

function form(fields: Record<string, string | string[]>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}
const validForm = (extra: Record<string, string | string[]> = {}) =>
  form({
    name: "n8n production",
    storeId: "",
    scopes: ["n8n:read", "n8n:sync", "n8n:jobs"],
    expiresInDays: "",
    ...extra,
  });

const callStatus = (token: string, storeId = STORE_A) =>
  statusRoute.GET(
    new NextRequest(`https://app.test/api/n8n/v1/stores/${storeId}/status`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ storeId }) },
  );

beforeEach(() => {
  env = fakeN8n();
  mocks.env = env;
  mocks.ctx = ctxFor(OWNER, WS_A, "owner");
  mocks.rpcCalls = [];
  mocks.rpcOverride = null;
  mocks.listExtraColumns = false;
  mocks.adminThrows = null;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

const createOk = async () => {
  const r = await actions.createApiKeyAction(undefined, validForm());
  if (!r?.created) throw new Error(`create failed: ${JSON.stringify(r)}`);
  return r.created;
};

describe("create API key — permissions", () => {
  it("owner creates a key: token returned once, only its SHA-256 hash is sent to the database", async () => {
    const created = await createOk();
    expect(created.token).toMatch(/^pis_live_/);
    const call = mocks.rpcCalls.find((c) => c.fn === "api_key_create")!;
    const secret = secretOf(created.token);
    expect(call.args.p_secret_hash).toBe(sha256Hex(secret));
    expect(JSON.stringify(call.args)).not.toContain(secret);
    expect(call.args).toMatchObject({
      p_user_id: OWNER,
      p_workspace_id: WS_A,
      p_store_id: null,
    });
    expect(logs.join("\n")).not.toContain(secret);
    expect((await callStatus(created.token)).status).toBe(200); // the new key works
  });

  it("admin can create a key (owner/admin manage the workspace)", async () => {
    mocks.ctx = ctxFor(ADMIN, WS_A, "admin");
    expect(
      (await actions.createApiKeyAction(undefined, validForm()))?.created
        ?.token,
    ).toMatch(/^pis_live_/);
  });

  it("member cannot create a key — refused before any database call", async () => {
    mocks.ctx = ctxFor(MEMBER, WS_A, "member");
    expect(await actions.createApiKeyAction(undefined, validForm())).toEqual({
      error: "Only workspace owners and admins can manage API keys.",
    });
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("the database re-checks the role too (stale session role = member in the DB) → forbidden", async () => {
    mocks.ctx = ctxFor(MEMBER, WS_A, "admin"); // UI thinks admin, DB says member
    expect(await actions.createApiKeyAction(undefined, validForm())).toEqual({
      error: "Only workspace owners and admins can manage API keys.",
    });
    expect(env.keys).toHaveLength(0);
  });

  it("signed-out user is sent to login for create and revoke; nothing is called", async () => {
    mocks.ctx = null;
    for (const p of [
      actions.createApiKeyAction(undefined, validForm()),
      actions.revokeApiKeyAction(crypto.randomUUID()),
    ]) {
      const err = await p.then(() => null).catch((e) => e);
      expect(String(err?.digest)).toContain("/login");
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("the workspace always comes from the session context — a forged workspaceId field is ignored", async () => {
    await actions.createApiKeyAction(
      undefined,
      validForm({ workspaceId: WS_B, userId: OWNER_B }),
    );
    expect(mocks.rpcCalls[0]!.args).toMatchObject({
      p_workspace_id: WS_A,
      p_user_id: OWNER,
    });
    expect(env.keys.every((k) => k.workspaceId === WS_A)).toBe(true);
  });

  it("owner of another workspace creating a key → only ever in their own workspace", async () => {
    mocks.ctx = ctxFor(OWNER_B, WS_B, "owner");
    const created = await actions.createApiKeyAction(undefined, validForm());
    expect(created?.created).toBeDefined();
    expect((await callStatus(created!.created!.token, STORE_A)).status).toBe(
      404,
    ); // can't reach workspace A
  });
});

describe("store-restricted keys", () => {
  it("a key restricted to a store of THIS workspace works for that store only", async () => {
    const r = await actions.createApiKeyAction(
      undefined,
      validForm({ storeId: STORE_A }),
    );
    expect(r?.created).toBeDefined();
    expect(mocks.rpcCalls[0]!.args.p_store_id).toBe(STORE_A);
  });

  it("restricting a key to another workspace's store is refused", async () => {
    expect(
      await actions.createApiKeyAction(
        undefined,
        validForm({ storeId: STORE_B }),
      ),
    ).toEqual({ error: "That store isn't in this workspace." });
    expect(env.keys).toHaveLength(0);
  });

  it("malformed store ids never reach the database", async () => {
    for (const storeId of ["not-a-uuid", "' or 1=1 --", `${STORE_A} `]) {
      expect(
        (await actions.createApiKeyAction(undefined, validForm({ storeId })))
          ?.error,
      ).toBeDefined();
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });
});

describe("input validation", () => {
  it.each([
    ["no name", { name: "  " }],
    ["name too long", { name: "x".repeat(81) }],
    ["no scopes", { scopes: [] }],
    ["unknown scope", { scopes: ["n8n:admin"] }],
    ["invalid expiry", { expiresInDays: "7" }],
  ])("%s → validation error, no database call", async (_label, extra) => {
    expect(
      (
        await actions.createApiKeyAction(
          undefined,
          validForm(extra as Record<string, string | string[]>),
        )
      )?.error,
    ).toBeDefined();
    expect(mocks.rpcCalls).toHaveLength(0);
  });
});

describe("secret handling", () => {
  it("the raw secret is only in the create response; listing never returns token or hash", async () => {
    const created = await createOk();
    mocks.listExtraColumns = true; // even if the SQL started returning extra columns
    const rows = await service.listApiKeys(OWNER, WS_A);
    const text = JSON.stringify(rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyPrefix).toBe(created.prefix);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "createdAt",
        "expiresAt",
        "id",
        "keyPrefix",
        "lastUsedAt",
        "name",
        "revokedAt",
        "scopes",
        "storeId",
        "storeName",
      ].sort(),
    );
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(secretOf(created.token));
    expect(text).not.toContain(env.keys[0]!.secretHash);
    expect(text).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("listing is refused for members and for other workspaces", async () => {
    await createOk();
    await expect(service.listApiKeys(MEMBER, WS_A)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(service.listApiKeys(OWNER_B, WS_A)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("database errors and unexpected failures never leak SQL text, hashes or config errors", async () => {
    mocks.rpcOverride = (fn) =>
      fn === "api_key_create"
        ? { data: null, error: { message: DB_LEAK } }
        : undefined;
    const dbErr = await actions.createApiKeyAction(undefined, validForm());
    expect(dbErr).toEqual({ error: "Something went wrong. Please try again." });
    mocks.rpcOverride = null;
    mocks.adminThrows = Object.assign(
      new Error("SUPABASE_SECRET_KEY=sb_secret_ABC is invalid"),
      { name: "AdminClientConfigError" },
    );
    const cfgErr = await actions.createApiKeyAction(undefined, validForm());
    const revokeErr = await actions.revokeApiKeyAction(crypto.randomUUID());
    expect(cfgErr).toEqual({
      error: "Something went wrong. Please try again.",
    });
    expect(revokeErr).toEqual({
      error: "Something went wrong. Please try again.",
    });
    const text = JSON.stringify([dbErr, cfgErr, revokeErr]) + logs.join("\n");
    for (const leak of [
      "deadbeef",
      "secret_hash",
      "duplicate key",
      "sb_secret_",
      "SUPABASE_SECRET_KEY",
    ])
      expect(text).not.toContain(leak);
  });

  it("too many keys → friendly limit message", async () => {
    mocks.rpcOverride = (fn) =>
      fn === "api_key_create"
        ? { data: null, error: { message: "too_many_keys" } }
        : undefined;
    expect(await actions.createApiKeyAction(undefined, validForm())).toEqual({
      error:
        "This workspace already has the maximum of 25 active API keys. Revoke one first.",
    });
  });
});

describe("revoke API key", () => {
  it("revoked key stops authenticating immediately; revoking again is safe (idempotent)", async () => {
    const created = await createOk();
    expect((await callStatus(created.token)).status).toBe(200);
    expect(await actions.revokeApiKeyAction(created.id)).toEqual({ ok: true });
    const res = await callStatus(created.token);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("INVALID_API_KEY");
    expect(await actions.revokeApiKeyAction(created.id)).toEqual({ ok: true });
    expect(env.keys.find((k) => k.id === created.id)!.revoked).toBe(true);
    expect((await callStatus(created.token)).status).toBe(401);
  });

  it("admin can revoke; member cannot (refused before any database call)", async () => {
    const created = await createOk();
    mocks.ctx = ctxFor(MEMBER, WS_A, "member");
    mocks.rpcCalls = [];
    expect(await actions.revokeApiKeyAction(created.id)).toEqual({
      error: "Only workspace owners and admins can manage API keys.",
    });
    expect(mocks.rpcCalls).toHaveLength(0);
    mocks.ctx = ctxFor(ADMIN, WS_A, "admin");
    expect(await actions.revokeApiKeyAction(created.id)).toEqual({ ok: true });
  });

  it("owner of another workspace cannot revoke this workspace's key (not found; key keeps working)", async () => {
    const created = await createOk();
    mocks.ctx = ctxFor(OWNER_B, WS_B, "owner");
    expect(await actions.revokeApiKeyAction(created.id)).toEqual({
      error: "We couldn't find that API key.",
    });
    expect(env.keys.find((k) => k.id === created.id)!.revoked).toBe(false);
    expect((await callStatus(created.token)).status).toBe(200);
  });

  it("unknown or malformed key ids → not found, no leak", async () => {
    expect(await actions.revokeApiKeyAction(crypto.randomUUID())).toEqual({
      error: "We couldn't find that API key.",
    });
    mocks.rpcCalls = [];
    for (const id of ["not-a-uuid", "", "1; drop table x"]) {
      expect(await actions.revokeApiKeyAction(id)).toEqual({
        error: "We couldn't find that API key.",
      });
    }
    expect(mocks.rpcCalls).toHaveLength(0);
  });

  it("the revoke response never contains the token, prefix secret part or hash", async () => {
    const created = await createOk();
    const r = await actions.revokeApiKeyAction(created.id);
    const text = JSON.stringify(r);
    expect(text).not.toContain(secretOf(created.token));
    expect(text).not.toContain(env.keys[0]!.secretHash);
  });
});
