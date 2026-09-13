import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "@aegix/config";
import { BillingError, buildPlanCatalog, findPlan } from "@aegix/billing";
import {
  createPaddleProvider,
  normalizePaddleSubscription,
  paddleSubscriptionSchema,
  parsePaddleEvent,
  paymentProviderFromConfig,
  signPaddleWebhook,
  verifyPaddleSignature,
  type PaddleSettings
} from "./billing-paddle.js";

const SECRET = "unit-fixture-webhook-secret";
const NOW = 1_790_000_000;
const PRICES = { pro: "pri_unitpro00000001", team: "pri_unitteam0000001" };

const catalog = buildPlanCatalog(
  { analysisDaily: 10, compareDaily: 50, askDaily: 25, marketsDaily: 200, monitorsActive: 3, apiKeysActive: 10, webhooksActive: 5, apiDaily: 500 },
  "USD"
);

function subscription(patch: Record<string, unknown> = {}) {
  return {
    id: "sub_unit0000000000000001",
    status: "active",
    customer_id: "ctm_unit0000000000000001",
    transaction_id: "txn_unit0000000000000001",
    custom_data: { aegix_checkout: "token-abc" },
    items: [{ price: { id: PRICES.pro } }],
    current_billing_period: { starts_at: "2026-09-01T00:00:00.000000Z", ends_at: "2026-10-01T00:00:00.000000Z" },
    scheduled_change: null,
    started_at: "2026-09-01T00:00:00Z",
    canceled_at: null,
    updated_at: "2026-09-01T00:00:00Z",
    ...patch
  };
}

function header(rawBody: string, ts = NOW, secret = SECRET) {
  return `ts=${ts};h1=${signPaddleWebhook(secret, ts, rawBody)}`;
}

const verify = (rawBody: string, value: string | string[] | undefined, nowSeconds = NOW) =>
  verifyPaddleSignature({ rawBody, header: value, secret: SECRET, nowSeconds, toleranceSeconds: 300 });

test("a correctly signed body verifies", () => {
  const body = JSON.stringify({ event_id: "evt_x" });
  assert.deepEqual(verify(body, header(body)), { valid: true });
});

test("tampering, the wrong secret, or a missing or malformed header is refused", () => {
  const body = '{"event_id":"evt_x","amount":1}';
  assert.deepEqual(verify(body.replace("1", "2"), header(body)), { valid: false, reason: "SIGNATURE_MISMATCH" });
  assert.deepEqual(verify(body, header(body, NOW, "another-secret")), { valid: false, reason: "SIGNATURE_MISMATCH" });
  assert.deepEqual(verify(`${body} `, header(body)), { valid: false, reason: "SIGNATURE_MISMATCH" }, "the raw bytes, not a re-serialization");
  assert.deepEqual(verify(body, undefined), { valid: false, reason: "MISSING_SIGNATURE" });
  assert.deepEqual(verify(body, ""), { valid: false, reason: "MISSING_SIGNATURE" });
  assert.deepEqual(verify(body, [header(body), header(body)]), { valid: false, reason: "MALFORMED_SIGNATURE" });
  for (const bad of ["h1=abc", "ts=1;h1=zz", `ts=abc;h1=${"a".repeat(64)}`, `ts=${NOW};ts=${NOW};h1=${"a".repeat(64)}`, "garbage"]) {
    assert.deepEqual(verify(body, bad), { valid: false, reason: "MALFORMED_SIGNATURE" }, bad);
  }
});

test("a signature outside the timestamp tolerance is refused in both directions", () => {
  const body = "{}";
  assert.deepEqual(verify(body, header(body, NOW - 301)), { valid: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" });
  assert.deepEqual(verify(body, header(body, NOW + 301)), { valid: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" });
  assert.deepEqual(verify(body, header(body, NOW - 299)), { valid: true });
});

test("during secret rotation any listed h1 may match", () => {
  const body = "{}";
  const rotated = `ts=${NOW};h1=${signPaddleWebhook("old-secret", NOW, body)};h1=${signPaddleWebhook(SECRET, NOW, body)}`;
  assert.deepEqual(verify(body, rotated), { valid: true });
});

test("Paddle statuses normalize to D11 states in one place", () => {
  const at = "2026-09-05T00:00:00Z";
  const norm = (patch: Record<string, unknown>) => {
    const result = normalizePaddleSubscription(paddleSubscriptionSchema.parse(subscription(patch)), PRICES, at);
    if ("unmapped" in result) throw new Error("unmapped");
    return result.snapshot;
  };
  assert.equal(norm({}).status, "ACTIVE");
  assert.equal(norm({}).planCode, "pro");
  assert.equal(norm({}).periodEnd, "2026-10-01T00:00:00.000Z");
  assert.equal(norm({ scheduled_change: { action: "cancel", effective_at: "2026-10-01T00:00:00Z" } }).status, "CANCELED");
  assert.equal(norm({ status: "past_due", scheduled_change: { action: "cancel", effective_at: "2026-10-01T00:00:00Z" } }).status, "PAST_DUE");
  assert.equal(norm({ status: "trialing" }).status, "TRIALING");
  assert.equal(norm({ status: "trialing" }).trialEnd, "2026-10-01T00:00:00.000Z");
  const canceled = norm({ status: "canceled", current_billing_period: null, canceled_at: "2026-09-04T00:00:00Z" });
  assert.equal(canceled.status, "EXPIRED");
  assert.equal(canceled.periodEnd, "2026-09-04T00:00:00.000Z");
  assert.equal(norm({ status: "paused" }).status, "EXPIRED");
  assert.equal(norm({ status: "something_new" }).status, "INCOMPLETE", "an unknown status grants nothing");
  assert.equal(norm({ items: [{ price: { id: PRICES.team } }] }).planCode, "team");
  assert.deepEqual(
    normalizePaddleSubscription(paddleSubscriptionSchema.parse(subscription({ items: [{ price: { id: "pri_notours000000" } }] })), PRICES, at),
    { unmapped: "UNKNOWN_PRICE" }
  );
});

test("webhook events parse into subscription, unmapped, other or invalid", () => {
  const event = (type: string, data: unknown) =>
    JSON.stringify({ event_id: "evt_unit0000000000000001", event_type: type, occurred_at: "2026-09-02T00:00:00.123456Z", data });
  const parsed = parsePaddleEvent(event("subscription.created", subscription()), PRICES);
  assert.equal(parsed.kind, "subscription");
  if (parsed.kind !== "subscription") return;
  assert.equal(parsed.snapshot.observedAt, "2026-09-02T00:00:00.123Z", "the event instant orders snapshots");
  assert.equal(parsed.checkoutRef, "txn_unit0000000000000001");
  assert.equal(parsed.checkoutToken, "token-abc");

  assert.equal(parsePaddleEvent(event("transaction.completed", { id: "txn_x" }), PRICES).kind, "other");
  assert.equal(parsePaddleEvent(event("subscription.updated", subscription({ items: [{ price: { id: "pri_other0000000" } }] })), PRICES).kind, "unmapped");
  assert.deepEqual(parsePaddleEvent("{nope", PRICES), { kind: "invalid", reason: "MALFORMED_JSON" });
  assert.deepEqual(parsePaddleEvent(JSON.stringify({ event_id: "x" }), PRICES), { kind: "invalid", reason: "INVALID_ENVELOPE" });
  assert.deepEqual(parsePaddleEvent(event("subscription.updated", { id: "sub_bad" }), PRICES), { kind: "invalid", reason: "INVALID_SUBSCRIPTION" });
});

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function providerWith(respond: (call: Captured) => Response, settings: Partial<PaddleSettings> = {}) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const provider = createPaddleProvider(
    {
      environment: "sandbox",
      apiKey: "unit-fixture-server-key",
      webhookSecret: SECRET,
      clientToken: "test_unitfixture",
      prices: PRICES,
      checkoutUrl: "https://app.example/app/billing/checkout",
      webhookToleranceSeconds: 300,
      ...settings
    },
    fetchImpl
  );
  return { provider, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("checkout sends only the server-mapped price and the binding token", async () => {
  const { provider, calls } = providerWith((call) =>
    json(201, { data: { id: "txn_unit0000000000000009", checkout: { url: `${(call.body.checkout as { url: string }).url}?_ptxn=txn_unit0000000000000009` } } })
  );
  const session = await provider.createCheckout({ userId: "user-1", plan: findPlan(catalog, "pro")!, checkoutToken: "tok" });
  assert.equal(session.reference, "txn_unit0000000000000009");
  assert.equal(calls[0]!.url, "https://sandbox-api.paddle.com/transactions");
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer unit-fixture-server-key");
  assert.equal(calls[0]!.headers.get("paddle-version"), "1");
  assert.deepEqual(calls[0]!.body.items, [{ price_id: PRICES.pro, quantity: 1 }]);
  assert.deepEqual(calls[0]!.body.custom_data, { aegix_user_id: "user-1", aegix_checkout: "tok", aegix_plan: "pro" });
  assert.equal("amount" in calls[0]!.body || "currency_code" in calls[0]!.body, false);

  await assert.rejects(
    provider.createCheckout({ userId: "user-1", plan: findPlan(catalog, "free")!, checkoutToken: "tok" }),
    (error: unknown) => error instanceof BillingError && error.code === "UNKNOWN_PLAN"
  );
});

test("a checkout link for another site is refused", async () => {
  const { provider } = providerWith(() =>
    json(201, { data: { id: "txn_unit0000000000000009", checkout: { url: "https://evil.example/pay?_ptxn=txn_unit0000000000000009" } } })
  );
  await assert.rejects(
    provider.createCheckout({ userId: "u", plan: findPlan(catalog, "pro")!, checkoutToken: "t" }),
    (error: unknown) => error instanceof BillingError && error.code === "PROVIDER_REJECTED"
  );
});

test("processor errors surface a code, never the processor's detail or the key", async () => {
  const { provider } = providerWith(() =>
    json(403, { error: { code: "forbidden", detail: "key unit-fixture-server-key lacks permission" } })
  );
  await assert.rejects(provider.createCheckout({ userId: "u", plan: findPlan(catalog, "pro")!, checkoutToken: "t" }), (error: unknown) => {
    assert.ok(error instanceof BillingError);
    assert.equal(error.code, "PROVIDER_REJECTED");
    assert.doesNotMatch(error.message, /unit-fixture-server-key|lacks permission/);
    return true;
  });

  const unreachable = createPaddleProvider(
    {
      environment: "sandbox",
      apiKey: "k",
      webhookSecret: SECRET,
      clientToken: "test_x",
      prices: PRICES,
      checkoutUrl: "https://app.example/c",
      webhookToleranceSeconds: 300
    },
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch
  );
  await assert.rejects(
    unreachable.createCheckout({ userId: "u", plan: findPlan(catalog, "pro")!, checkoutToken: "t" }),
    (error: unknown) => error instanceof BillingError && error.code === "PROVIDER_UNAVAILABLE"
  );
});

test("references are validated before they reach a processor URL", async () => {
  const { provider, calls } = providerWith(() => json(200, { data: {} }));
  await assert.rejects(
    provider.createPortalSession({ customerRef: "ctm_unit00000000/../../transactions", subscriptionRef: "sub_unit0000000000000001" }),
    (error: unknown) => error instanceof BillingError && error.code === "PROVIDER_REJECTED"
  );
  await assert.rejects(provider.cancelSubscription("sub_x?y", { immediate: false }));
  assert.equal(calls.length, 0);
});

test("cancel and resume return the processor's normalized state", async () => {
  const { provider, calls } = providerWith((call) =>
    json(200, {
      data: subscription(
        call.method === "PATCH"
          ? { updated_at: "2026-09-03T00:00:00Z" }
          : { scheduled_change: { action: "cancel", effective_at: "2026-10-01T00:00:00Z" }, updated_at: "2026-09-02T00:00:00Z" }
      )
    })
  );
  const canceled = await provider.cancelSubscription("sub_unit0000000000000001", { immediate: false });
  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.observedAt, "2026-09-02T00:00:00.000Z");
  assert.deepEqual(calls[0]!.body, { effective_from: "next_billing_period" });
  const resumed = await provider.resumeSubscription("sub_unit0000000000000001");
  assert.equal(resumed.status, "ACTIVE");
  assert.equal(calls[1]!.method, "PATCH");
  assert.deepEqual(calls[1]!.body, { scheduled_change: null });
});

function paddleEnv(overrides: Record<string, string> = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379",
    BILLING_PROVIDER: "paddle",
    BILLING_SECRET_KEY: "unit-fixture-server-key",
    BILLING_WEBHOOK_SECRET: SECRET,
    BILLING_CLIENT_TOKEN: "test_unitfixture",
    BILLING_PRICE_PRO: PRICES.pro,
    BILLING_CHECKOUT_URL: "https://app.example/app/billing/checkout",
    ...overrides
  };
}

test("manual stays the default provider", () => {
  const provider = paymentProviderFromConfig(loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x@localhost/aegix_test", REDIS_URL: "redis://localhost:6379" }));
  assert.equal(provider.name, "manual");
  assert.equal(provider.supportsSelfServe, false);
  assert.equal(provider.webhooks, null);
});

test("a paddle deployment refuses to start without its settings, naming keys but never values", () => {
  assert.equal(paymentProviderFromConfig(loadConfig(paddleEnv())).name, "paddle");
  assert.throws(() => loadConfig(paddleEnv({ BILLING_WEBHOOK_SECRET: "" })), /requires BILLING_WEBHOOK_SECRET/);
  assert.throws(() => loadConfig(paddleEnv({ BILLING_PRICE_PRO: "pro-plan" })), /BILLING_PRICE_PRO must be a Paddle price id/);
  assert.throws(() => loadConfig(paddleEnv({ BILLING_CLIENT_TOKEN: "live_unitfixture" })), /does not belong to the sandbox environment/);
  assert.throws(
    () => loadConfig(paddleEnv({ BILLING_SECRET_KEY: "pdl_live_apikey_fixture" })),
    (error: unknown) => error instanceof Error && /BILLING_SECRET_KEY does not belong/.test(error.message) && !error.message.includes("pdl_live_apikey_fixture")
  );
});
