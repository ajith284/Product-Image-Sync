import { createHmac } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/shopify/webhooks";

import { config, fakeRepo, SHOP } from "./helpers/shopify-fakes";

/**
 * Prompt 14C — route-level tests for POST /api/shopify/webhooks
 * (lib/shopify/webhooks.ts has handler-level tests in shopify-oauth-flow.test.ts).
 * These go through the real route: raw body → HMAC → topic → repository → empty response.
 */

const mocks = vi.hoisted(() => ({
  deps: null as unknown,
  depsError: null as Error | null,
}));
vi.mock("@/lib/shopify/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/runtime")>();
  return {
    ...actual,
    getShopifyDeps: vi.fn(() => {
      if (mocks.depsError) throw mocks.depsError;
      return mocks.deps;
    }),
  };
});

const { POST } = await import("@/app/api/shopify/webhooks/route");

const MARKER = "PAYLOAD-MARKER-customer-email@example.com";
const BODY = JSON.stringify({
  id: 548380009,
  name: "Royal Sofa",
  domain: SHOP,
  email: MARKER,
});
const sign = (body: string | Buffer, secret = config.clientSecret) =>
  createHmac("sha256", secret).update(body).digest("base64");

let s: ReturnType<typeof fakeRepo>;
let seen: Set<string>;
let logs: string[];

beforeEach(() => {
  seen = new Set();
  // Idempotency like the SQL functions: one row per webhook id.
  s = fakeRepo({
    handleAppUninstalled: vi.fn(async (id: string) =>
      seen.has(id) ? "duplicate" : (seen.add(id), "disconnected"),
    ),
    handleShopRedact: vi.fn(async (id: string) =>
      seen.has(id) ? "duplicate" : (seen.add(id), "redacted"),
    ),
    recordWebhook: vi.fn(async (id: string) =>
      seen.has(id) ? false : (seen.add(id), true),
    ),
  });
  mocks.deps = { config, repo: s.repo };
  mocks.depsError = null;
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...a: unknown[]) => void logs.push(a.map(String).join(" ")),
    );
  }
});
afterEach(() => vi.restoreAllMocks());

function webhook(
  opts: {
    body?: string;
    hmac?: string | null;
    topic?: string | null;
    shop?: string | null;
    id?: string | null;
  } = {},
) {
  const body = opts.body ?? BODY;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const hmac = opts.hmac === undefined ? sign(body) : opts.hmac;
  if (hmac !== null) headers["x-shopify-hmac-sha256"] = hmac;
  if (opts.topic !== null)
    headers["x-shopify-topic"] = opts.topic ?? "app/uninstalled";
  if (opts.shop !== null) headers["x-shopify-shop-domain"] = opts.shop ?? SHOP;
  if (opts.id !== null)
    headers["x-shopify-webhook-id"] =
      opts.id ?? "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043";
  return POST(
    new NextRequest("https://app.test/api/shopify/webhooks", {
      method: "POST",
      headers,
      body,
    }),
  );
}

async function expectEmpty(res: Response) {
  expect(await res.text()).toBe("");
}
const nothingProcessed = () => {
  expect(s.repo.handleAppUninstalled).not.toHaveBeenCalled();
  expect(s.repo.recordWebhook).not.toHaveBeenCalled();
};
const leaked = () => {
  const text = logs.join("\n");
  return [MARKER, config.clientSecret, BODY].filter((x) => text.includes(x));
};

describe("POST /api/shopify/webhooks", () => {
  it("valid HMAC + app/uninstalled → 200, processed once for that shop", async () => {
    const res = await webhook();
    expect(res.status).toBe(200);
    await expectEmpty(res);
    expect(s.repo.handleAppUninstalled).toHaveBeenCalledWith(
      "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      SHOP,
    );
  });

  it.each([
    ["missing HMAC header", null],
    ["empty HMAC header", ""],
    ["HMAC signed with another secret", sign(BODY, "attacker-secret")],
    ["HMAC of a different body", sign(BODY + " ")],
    [
      "hex instead of base64",
      createHmac("sha256", config.clientSecret).update(BODY).digest("hex"),
    ],
    ["garbage", "not base64!!"],
    ["truncated HMAC", sign(BODY).slice(0, 20)],
  ])("%s → 401, nothing processed, empty response", async (_label, hmac) => {
    const res = await webhook({ hmac });
    expect(res.status).toBe(401);
    await expectEmpty(res);
    nothingProcessed();
  });

  it("HMAC is checked before topic/shop: an unsigned request with a malformed shop is 401, not 400", async () => {
    const res = await webhook({ hmac: null, shop: "evil.com" });
    expect(res.status).toBe(401);
    nothingProcessed();
  });

  it.each([
    ["non-myshopify domain", "evil.com"],
    ["domain with path", `${SHOP}/admin`],
    ["empty shop", ""],
  ])(
    "signed but malformed shop header (%s) → 400, nothing processed",
    async (_label, shop) => {
      const res = await webhook({ shop });
      expect(res.status).toBe(400);
      nothingProcessed();
    },
  );

  it("signed but missing shop or topic header → 400", async () => {
    expect((await webhook({ shop: null })).status).toBe(400);
    expect((await webhook({ topic: null })).status).toBe(400);
    nothingProcessed();
  });

  it("duplicate webhook id → 200 again but processed only once", async () => {
    expect((await webhook()).status).toBe(200);
    expect((await webhook()).status).toBe(200);
    expect(s.repo.handleAppUninstalled).toHaveBeenCalledTimes(2);
    expect(
      await vi.mocked(s.repo.handleAppUninstalled).mock.results[1]!.value,
    ).toBe("duplicate");
    // customer compliance topics are deduplicated the same way
    expect(
      (await webhook({ topic: "customers/redact", id: "dup-redact-1" })).status,
    ).toBe(200);
    expect(
      (await webhook({ topic: "customers/redact", id: "dup-redact-1" })).status,
    ).toBe(200);
    expect(await vi.mocked(s.repo.recordWebhook).mock.results[1]!.value).toBe(
      false,
    );
  });

  it("no webhook-id header → a stable digest is used, so retries are still deduplicated", async () => {
    await webhook({ id: null });
    await webhook({ id: null });
    const ids = vi
      .mocked(s.repo.handleAppUninstalled)
      .mock.calls.map((c) => c[0]);
    expect(ids[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ids[1]).toBe(ids[0]);
  });

  it("the RAW body is what gets authenticated (whitespace, key order and UTF-8 preserved)", async () => {
    const raw =
      '{ "name":"Café Sofá",\n  "domain" : "royal-sofa.myshopify.com",   "id":1 }';
    expect(
      (await webhook({ body: raw, hmac: sign(Buffer.from(raw, "utf8")) }))
        .status,
    ).toBe(200);
    // same JSON, re-serialized → the original signature no longer matches
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect(
      (
        await webhook({
          body: reserialized,
          hmac: sign(Buffer.from(raw, "utf8")),
          id: "another-id",
        })
      ).status,
    ).toBe(401);
  });

  it("an empty body is only accepted when it is signed", async () => {
    expect((await webhook({ body: "", hmac: null })).status).toBe(401);
    expect((await webhook({ body: "", id: "empty-1" })).status).toBe(200);
  });

  it("unknown topic (signed) → acknowledged 200 and recorded, never acted on", async () => {
    const res = await webhook({
      topic: "orders/create",
      id: "unknown-topic-1",
    });
    expect(res.status).toBe(200);
    await expectEmpty(res);
    expect(s.repo.recordWebhook).toHaveBeenCalledWith(
      "unknown-topic-1",
      "orders/create",
      SHOP,
    );
    expect(s.repo.handleAppUninstalled).not.toHaveBeenCalled();
  });

  it("overlong topic / webhook-id headers are truncated before storage", async () => {
    await webhook({ topic: "x/" + "y".repeat(500), id: "i".repeat(1000) });
    const [id, topic] = vi.mocked(s.repo.recordWebhook).mock.calls[0]!;
    expect(id.length).toBeLessThanOrEqual(200);
    expect(topic.length).toBeLessThanOrEqual(100);
  });

  it("payloads are never echoed or logged (success and failure)", async () => {
    for (const res of [
      await webhook(),
      await webhook({ hmac: sign(BODY, "wrong") }),
      await webhook({ shop: "evil.com" }),
    ]) {
      await expectEmpty(res);
    }
    expect(leaked()).toEqual([]);
  });

  it("repository failure → safe empty 500 (Shopify retries), no payload or error text leaked", async () => {
    s.repo.handleAppUninstalled = vi.fn(async () => {
      throw new Error(
        `db down: postgres://service_role:sb_secret_XYZ@db ${MARKER}`,
      );
    });
    const res = await webhook();
    expect(res.status).toBe(500);
    await expectEmpty(res);
    expect(leaked()).toEqual([]);
    expect(logs.join("\n")).not.toContain("sb_secret_");
  });

  it("missing server configuration → empty 500, nothing processed", async () => {
    mocks.depsError = Object.assign(
      new Error("SHOPIFY_CLIENT_SECRET is missing"),
      { name: "ShopifyConfigError" },
    );
    const res = await webhook();
    expect(res.status).toBe(500);
    await expectEmpty(res);
    nothingProcessed();
  });
});

// ---------------------------------------------------------------------------
// Prompt 14F — mandatory compliance topics
// ---------------------------------------------------------------------------
describe("POST /api/shopify/webhooks — compliance topics", () => {
  it("shop/redact (signed) → 200 and the shop's Shopify data is erased via the redact function", async () => {
    const res = await webhook({ topic: "shop/redact", id: "redact-1", body: JSON.stringify({ shop_id: 954889, shop_domain: SHOP }) });
    expect(res.status).toBe(200);
    await expectEmpty(res);
    expect(s.repo.handleShopRedact).toHaveBeenCalledWith("redact-1", SHOP);
    expect(s.repo.recordWebhook).not.toHaveBeenCalled();
    expect(s.repo.handleAppUninstalled).not.toHaveBeenCalled();
  });

  it("shop/redact is idempotent: a redelivery is acknowledged without erasing again", async () => {
    await webhook({ topic: "shop/redact", id: "redact-dup" });
    expect((await webhook({ topic: "shop/redact", id: "redact-dup" })).status).toBe(200);
    expect(await vi.mocked(s.repo.handleShopRedact).mock.results[1]!.value).toBe("duplicate");
  });

  it("shop/redact for a DIFFERENT shop header only ever targets that shop", async () => {
    await webhook({ topic: "shop/redact", id: "redact-other", shop: "another-shop.myshopify.com" });
    expect(s.repo.handleShopRedact).toHaveBeenCalledWith("redact-other", "another-shop.myshopify.com");
  });

  it("unsigned / wrongly signed shop/redact → 401 and NOTHING is erased", async () => {
    expect((await webhook({ topic: "shop/redact", hmac: null })).status).toBe(401);
    expect((await webhook({ topic: "shop/redact", hmac: sign(BODY, "attacker-secret") })).status).toBe(401);
    expect(s.repo.handleShopRedact).not.toHaveBeenCalled();
  });

  it.each(["customers/data_request", "customers/redact"])(
    "%s → 200, recorded only (the app holds no customer data; nothing invented, nothing deleted)",
    async (topic) => {
      const body = JSON.stringify({ shop_id: 1, shop_domain: SHOP, customer: { id: 191167, email: MARKER }, orders_requested: [1, 2] });
      const res = await webhook({ topic, id: `cust-${topic}`, body });
      expect(res.status).toBe(200);
      await expectEmpty(res);
      expect(s.repo.recordWebhook).toHaveBeenCalledWith(`cust-${topic}`, topic, SHOP);
      expect(s.repo.handleShopRedact).not.toHaveBeenCalled();
      expect(leaked()).toEqual([]);
    },
  );

  it("a database failure during shop/redact → 500 so Shopify retries (no erasure claimed)", async () => {
    s.repo.handleShopRedact = vi.fn(async () => {
      throw new Error("db down sb_secret_X");
    });
    const res = await webhook({ topic: "shop/redact", id: "redact-fail" });
    expect(res.status).toBe(500);
    expect(logs.join("\n")).not.toContain("sb_secret_");
  });
});

// ---------------------------------------------------------------------------
// Prompt 14C.1 — request-size hardening (MAX_WEBHOOK_BODY_BYTES = 1 MiB)
// ---------------------------------------------------------------------------
const MAX = MAX_WEBHOOK_BODY_BYTES;
const HEADERS = (body: Buffer | null, extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-shopify-topic": "app/uninstalled",
  "x-shopify-shop-domain": SHOP,
  "x-shopify-webhook-id": `size-${Math.random()}`,
  ...(body ? { "x-shopify-hmac-sha256": sign(body) } : {}),
  ...extra,
});
const post = (body: BodyInit | null, headers: Record<string, string>) =>
  POST(
    new NextRequest("https://app.test/api/shopify/webhooks", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as NonNullable<ConstructorParameters<typeof NextRequest>[1]>),
  );

/** Valid JSON of exactly `size` bytes. */
function jsonOfSize(size: number) {
  const head = `{"domain":"${SHOP}","email":"${MARKER}","pad":"`;
  return Buffer.from(head + "x".repeat(size - head.length - 2) + '"}', "utf8");
}

/** A lazily generated body of `total` bytes; counts how much the server actually pulled. */
function lazyStream(total: number, chunk = 64 * 1024) {
  let produced = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced >= total) return controller.close();
        const n = Math.min(chunk, total - produced);
        produced += n;
        controller.enqueue(new Uint8Array(n).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  ); // produce only when actually read
  return { stream, pulled: () => produced, cancelled: () => cancelled };
}

const depsLoaded = async () =>
  vi.mocked((await import("@/lib/shopify/runtime")).getShopifyDeps).mock.calls
    .length;

describe("POST /api/shopify/webhooks — body size limit", () => {
  it("the limit is 1 MiB", () => {
    expect(MAX).toBe(1_048_576);
  });

  it("valid signed webhook with a correct Content-Length → 200 (unchanged behaviour)", async () => {
    const body = Buffer.from(BODY);
    const res = await post(
      body,
      HEADERS(body, { "content-length": String(body.length) }),
    );
    expect(res.status).toBe(200);
    expect(s.repo.handleAppUninstalled).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["just below the limit", MAX - 1],
    ["exactly at the limit", MAX],
  ])("%s → accepted and processed", async (_label, size) => {
    const body = jsonOfSize(size);
    expect(body.length).toBe(size);
    const res = await post(body, HEADERS(body));
    expect(res.status).toBe(200);
    expect(s.repo.handleAppUninstalled).toHaveBeenCalledTimes(1);
  });

  it("one byte over the limit → 413 even with a VALID HMAC; nothing processed", async () => {
    const body = jsonOfSize(MAX + 1);
    const res = await post(body, HEADERS(body));
    expect(res.status).toBe(413);
    await expectEmpty(res);
    nothingProcessed();
  });

  it("Content-Length above the limit → 413 without reading a single body byte or loading credentials", async () => {
    const lazy = lazyStream(10 * MAX);
    const before = await depsLoaded();
    const res = await post(
      lazy.stream,
      HEADERS(null, {
        "x-shopify-hmac-sha256": "AAAA",
        "content-length": String(MAX + 1),
      }),
    );
    expect(res.status).toBe(413);
    expect(lazy.pulled()).toBe(0);
    expect(await depsLoaded()).toBe(before);
    nothingProcessed();
  });

  it("oversized body WITHOUT Content-Length → 413", async () => {
    const body = jsonOfSize(2 * MAX);
    const headers = HEADERS(body);
    expect("content-length" in headers).toBe(false);
    const res = await post(body, headers);
    expect(res.status).toBe(413);
    nothingProcessed();
  });

  it("chunked / streamed 100 MB body → 413 after reading at most limit + one chunk; stream cancelled", async () => {
    const chunk = 64 * 1024;
    const lazy = lazyStream(100 * MAX, chunk);
    const res = await post(
      lazy.stream,
      HEADERS(null, { "x-shopify-hmac-sha256": "AAAA" }),
    );
    expect(res.status).toBe(413);
    expect(lazy.pulled()).toBeLessThanOrEqual(MAX + chunk);
    expect(lazy.cancelled()).toBe(true);
    nothingProcessed();
  });

  it("a lying Content-Length (declares 100 bytes, streams 3 MiB) is still bounded → 413", async () => {
    const lazy = lazyStream(3 * MAX);
    const res = await post(
      lazy.stream,
      HEADERS(null, {
        "x-shopify-hmac-sha256": "AAAA",
        "content-length": "100",
      }),
    );
    expect(res.status).toBe(413);
    expect(lazy.pulled()).toBeLessThanOrEqual(MAX + 64 * 1024);
    nothingProcessed();
  });

  it("oversized request with an INVALID HMAC is rejected for size (413) before any HMAC / repo work", async () => {
    const body = jsonOfSize(MAX + 100);
    const before = await depsLoaded();
    const res = await post(
      body,
      HEADERS(null, { "x-shopify-hmac-sha256": sign(body, "attacker-secret") }),
    );
    expect(res.status).toBe(413);
    expect(await depsLoaded()).toBe(before); // the client secret was never even loaded
    nothingProcessed();
  });

  it("invalid HMAC below the limit is still 401", async () => {
    const body = jsonOfSize(MAX);
    const res = await post(
      body,
      HEADERS(null, { "x-shopify-hmac-sha256": sign(body, "attacker-secret") }),
    );
    expect(res.status).toBe(401);
    nothingProcessed();
  });

  it("413 responses carry no payload, no secret; the log line names only the outcome", async () => {
    const body = jsonOfSize(MAX + 1);
    const res = await post(body, HEADERS(body));
    expect(res.status).toBe(413);
    await expectEmpty(res);
    expect(res.headers.get("content-type")).toBeNull();
    expect(leaked()).toEqual([]);
    expect(logs).toContain("[shopify] webhook payload_too_large");
  });

  it.each([["abc"], ["-1"], ["1e9"], ["12 34"]])(
    "malformed Content-Length %j → 400, nothing processed",
    async (cl) => {
      const body = Buffer.from(BODY);
      const res = await post(body, HEADERS(body, { "content-length": cl }));
      expect(res.status).toBe(400);
      nothingProcessed();
    },
  );

  it("an upload that breaks mid-stream → 400, nothing processed", async () => {
    let sent = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 2) controller.enqueue(new Uint8Array(1024).fill(120));
        else controller.error(new Error("client aborted"));
      },
    });
    const res = await post(
      broken,
      HEADERS(null, { "x-shopify-hmac-sha256": "AAAA" }),
    );
    expect(res.status).toBe(400);
    nothingProcessed();
  });

  it("RAW bytes are authenticated: a body that is not valid UTF-8 still verifies when correctly signed", async () => {
    // request.text() would have replaced these bytes with U+FFFD and broken the HMAC.
    const body = Buffer.concat([
      Buffer.from('{"domain":"royal-sofa.myshopify.com","x":"'),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('"}'),
    ]);
    const res = await post(body, HEADERS(body));
    expect(res.status).toBe(200);
  });

  it("streamed body below the limit (chunked, no Content-Length) still works", async () => {
    const body = jsonOfSize(300 * 1024);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) return controller.close();
        controller.enqueue(
          new Uint8Array(body.subarray(offset, offset + 7_000)),
        );
        offset += 7_000;
      },
    });
    const res = await post(stream, HEADERS(body));
    expect(res.status).toBe(200);
    expect(s.repo.handleAppUninstalled).toHaveBeenCalledTimes(1);
  });
});
