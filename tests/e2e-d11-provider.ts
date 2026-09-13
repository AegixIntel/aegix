import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createBillingRepo, type Sql } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";
import { assessFreshness, type MarketDataProvider } from "../packages/markets/src/index.js";
import { buildServer } from "../apps/api/src/server.js";
import { signPaddleWebhook } from "../apps/api/src/billing-paddle.js";
import { runBillingLifecycle } from "../apps/worker/src/processors/billing.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

/**
 * D11 payment processor end-to-end: checkout, customer portal, signed
 * webhooks and the full subscription lifecycle, against the real API, the
 * real database, the real lifecycle sweep and the real Paddle adapter.
 *
 * Only Paddle's HTTP API is replaced — by an in-memory fake that behaves the
 * way Paddle's documentation describes — so the test is deterministic and
 * needs no network or credentials. Webhooks are signed exactly as Paddle
 * signs them. The live sandbox proof runs the same flow against Paddle
 * itself (docs/milestone-d11.md §6).
 */

const MARKETS_FREE_QUOTA = 2;
const API_KEY = "e2e-fixture-server-key";
const WEBHOOK_SECRET = "e2e-fixture-webhook-secret";
const CLIENT_TOKEN = "test_e2efixtureclienttoken";
const PRICE_PRO = "pri_e2eprofixture000000000000";
const PRICE_TEAM = "pri_e2eteamfixture00000000000";
const CHECKOUT_URL = "http://localhost:3000/app/billing/checkout";
const SANDBOX_API = "https://sandbox-api.paddle.com";
/** Keeps processor ids unique across runs against the same database. */
const RUN = Date.now().toString(36);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function authenticate(app: Awaited<ReturnType<typeof buildServer>>) {
  const key = ed25519.utils.randomPrivateKey();
  const address = base58.encode(ed25519.getPublicKey(key));
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet: address } });
  const data = challenge.json().data;
  const verification = await app.inject({
    method: "POST",
    url: "/v1/auth/wallet/verify",
    payload: {
      wallet: address,
      challengeId: data.challengeId,
      nonce: data.nonce,
      signature: base58.encode(ed25519.sign(new TextEncoder().encode(data.message), key))
    }
  });
  assert.equal(verification.statusCode, 200);
  const auth = verification.json().data;
  return { userId: auth.user.id as string, headers: { authorization: `Bearer ${auth.token}` } };
}

interface FakeSubscription {
  id: string;
  status: string;
  customer_id: string;
  transaction_id: string;
  custom_data: Record<string, unknown> | null;
  items: Array<{ price: { id: string } }>;
  current_billing_period: { starts_at: string; ends_at: string } | null;
  scheduled_change: { action: string; effective_at: string } | null;
  started_at: string;
  canceled_at: string | null;
  updated_at: string;
}

interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  authorization: string | null;
  version: string | null;
}

/** Paddle's API as its documentation describes it, in memory. */
function createFakePaddle() {
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${RUN}${(++seq).toString(36).padStart(8, "0")}`;
  const calls: FakeCall[] = [];
  const transactions = new Map<string, { id: string; items: Array<{ price_id: string; quantity: number }>; custom_data: Record<string, unknown> }>();
  const subscriptions = new Map<string, FakeSubscription>();
  const reply = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path: url.pathname, body, authorization: headers.get("authorization"), version: headers.get("paddle-version") });
    if (url.origin !== SANDBOX_API) return reply(404, { error: { code: "not_found" } });

    if (method === "POST" && url.pathname === "/transactions" && body) {
      const transaction = {
        id: id("txn"),
        items: body.items as Array<{ price_id: string; quantity: number }>,
        custom_data: body.custom_data as Record<string, unknown>
      };
      transactions.set(transaction.id, transaction);
      const checkout = body.checkout as { url: string };
      return reply(201, { data: { id: transaction.id, status: "ready", checkout: { url: `${checkout.url}?_ptxn=${transaction.id}` } } });
    }

    const portal = url.pathname.match(/^\/customers\/(ctm_[a-z0-9]+)\/portal-sessions$/);
    if (method === "POST" && portal) {
      return reply(201, {
        data: {
          id: id("cpls"),
          customer_id: portal[1],
          urls: { general: { overview: `https://sandbox-customer-portal.paddle.com/cpl_fixture?customer=${portal[1]}` }, subscriptions: [] }
        }
      });
    }

    const cancel = url.pathname.match(/^\/subscriptions\/(sub_[a-z0-9]+)\/cancel$/);
    const update = url.pathname.match(/^\/subscriptions\/(sub_[a-z0-9]+)$/);
    const target = subscriptions.get((cancel ?? update)?.[1] ?? "");
    if ((cancel && method === "POST") || (update && method === "PATCH")) {
      if (!target) return reply(404, { error: { code: "entity_not_found" } });
      const now = new Date().toISOString();
      if (cancel && body?.effective_from === "immediately") {
        Object.assign(target, { status: "canceled", canceled_at: now, scheduled_change: null, current_billing_period: null });
      } else if (cancel) {
        target.scheduled_change = { action: "cancel", effective_at: target.current_billing_period!.ends_at };
      } else if (body && "scheduled_change" in body && body.scheduled_change === null) {
        target.scheduled_change = null;
      }
      target.updated_at = now;
      return reply(200, { data: structuredClone(target) });
    }
    return reply(404, { error: { code: "not_found" } });
  }) as typeof fetch;

  /** The customer pays: Paddle creates the subscription from the transaction. */
  function complete(transactionId: string, at: Date): FakeSubscription {
    const transaction = transactions.get(transactionId);
    assert.ok(transaction, "the checkout transaction exists");
    const subscription: FakeSubscription = {
      id: id("sub"),
      status: "active",
      customer_id: id("ctm"),
      transaction_id: transaction.id,
      custom_data: transaction.custom_data,
      items: transaction.items.map((item) => ({ price: { id: item.price_id } })),
      current_billing_period: { starts_at: at.toISOString(), ends_at: new Date(at.getTime() + 30 * 86_400_000).toISOString() },
      scheduled_change: null,
      started_at: at.toISOString(),
      canceled_at: null,
      updated_at: at.toISOString()
    };
    subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  return { fetch: fetchImpl, calls, subscriptions, complete, id };
}

let eventSeq = 0;
function paddleEvent(type: string, data: unknown, occurredAt: Date) {
  eventSeq += 1;
  const suffix = `${RUN}${eventSeq.toString(36).padStart(8, "0")}`;
  return { event_id: `evt_${suffix}`, event_type: type, occurred_at: occurredAt.toISOString(), notification_id: `ntf_${suffix}`, data: structuredClone(data) };
}

function signatureFor(rawBody: string, options: { secret?: string; timestamp?: number } = {}) {
  const ts = options.timestamp ?? Math.floor(Date.now() / 1000);
  return `ts=${ts};h1=${signPaddleWebhook(options.secret ?? WEBHOOK_SECRET, ts, rawBody)}`;
}

async function deliver(
  app: Awaited<ReturnType<typeof buildServer>>,
  payload: unknown,
  options: { secret?: string; timestamp?: number; signature?: string | null; contentType?: string; rawBody?: string } = {}
) {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": options.contentType ?? "application/json" };
  const signature = options.signature === undefined ? signatureFor(rawBody, options) : options.signature;
  if (signature !== null) headers["paddle-signature"] = signature;
  return app.inject({ method: "POST", url: "/v1/billing/webhooks/paddle", headers, payload: rawBody });
}

function fixtureMarkets(): MarketDataProvider {
  const now = new Date();
  return {
    name: "e2e-d11-provider-fixture",
    async getQuote(asset) {
      return {
        asset,
        priceUsd: 200,
        volume24hUsd: 1000,
        marketCapUsd: null,
        percentChange24h: null,
        provider: "e2e-d11-provider-fixture",
        freshness: assessFreshness(now.toISOString(), now)
      };
    },
    async getHistory() {
      return Array.from({ length: 24 }, (_, i) => ({
        timestamp: new Date(now.getTime() - (23 - i) * 3600000).toISOString(),
        priceUsd: 100,
        volumeUsd: 100
      }));
    }
  };
}

async function cleanup(sql: Sql, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    await sql`delete from billing_checkouts where user_id = ${id}`;
    await sql`delete from privacy_monitors where user_id = ${id}`;
    await sql`delete from saved_analyses where user_id = ${id}`;
    await sql`delete from invoices where user_id = ${id}`;
    await sql`delete from billing_events where user_id = ${id}`;
    await sql`delete from subscriptions where user_id = ${id}`;
    await sql`delete from usage_records where user_id = ${id}`;
    await sql`delete from profiles where id = ${id}`;
  }
  await sql`delete from billing_provider_events where provider = 'paddle' and event_id like ${`evt_${RUN}%`}`;
}

async function main(): Promise<void> {
  const safe = requireSafeTestDatabaseReset();
  const config = loadConfig({
    ...process.env,
    MARKETS_DAILY_QUOTA: String(MARKETS_FREE_QUOTA),
    MAX_ACTIVE_MONITORS_PER_USER: "1",
    BILLING_GRACE_DAYS: "7",
    BILLING_PROVIDER: "paddle",
    BILLING_ENVIRONMENT: "sandbox",
    BILLING_SECRET_KEY: API_KEY,
    BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET,
    BILLING_CLIENT_TOKEN: CLIENT_TOKEN,
    BILLING_PRICE_PRO: PRICE_PRO,
    BILLING_PRICE_TEAM: PRICE_TEAM,
    BILLING_CHECKOUT_URL: CHECKOUT_URL,
    BILLING_WEBHOOK_MAX_BYTES: "16384"
  });

  // Every log line the API writes during the run, to prove no secret reaches one.
  const logged: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (stdoutWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    logged.push(String(chunk));
    return (stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

  const sql = createDb(safe.databaseUrl);
  const repo = createBillingRepo(sql);
  const paddle = createFakePaddle();
  const app = await buildServer({ config, marketProvider: fixtureMarkets(), billingFetch: paddle.fetch });
  const created: string[] = [];
  // Webhook instants start an hour back so later processor API calls are newer.
  const base = Date.now() - 3_600_000;
  const at = (seconds: number) => new Date(base + seconds * 1000);

  const subscriptionOf = async (headers: Record<string, string>) =>
    (await app.inject({ url: "/v1/billing/subscription", headers })).json();
  const ledger = async (userId: string) =>
    (await sql<Array<{ event_type: string }>>`select event_type from billing_events where user_id = ${userId} order by id asc`).map((row) => row.event_type);
  const monitorStatuses = async (userId: string) =>
    (await sql<Array<{ status: string }>>`
      select status from privacy_monitors where user_id = ${userId} order by created_at asc, id asc
    `).map((row) => row.status);
  const retained = async (userId: string) =>
    (await sql<Array<{ saved: string; comparisons: string; monitors: string; profile: string }>>`
      select
        (select count(*)::text from saved_analyses where user_id = ${userId}) as saved,
        (select count(*)::text from saved_comparisons where user_id = ${userId}) as comparisons,
        (select count(*)::text from privacy_monitors where user_id = ${userId}) as monitors,
        (select count(*)::text from profiles where id = ${userId}) as profile
    `)[0];

  try {
    // ---- Self-serve is on; the catalog exposes no processor price ----
    const plans = await app.inject({ url: "/v1/billing/plans" });
    assert.equal(plans.json().selfServe, true);
    assert.equal(plans.json().provider, "paddle");
    assert.ok(!plans.body.includes(PRICE_PRO), "processor price ids stay server-side");

    const buyer = await authenticate(app);
    created.push(buyer.userId);
    const other = await authenticate(app);
    created.push(other.userId);

    const client = await app.inject({ url: "/v1/billing/checkout/client", headers: buyer.headers });
    assert.equal(client.statusCode, 200);
    assert.deepEqual(client.json(), { provider: "paddle", environment: "sandbox", token: CLIENT_TOKEN });
    assert.equal((await app.inject({ url: "/v1/billing/checkout/client" })).statusCode, 401);

    // ---- Checkout: the server maps plan → price; the browser controls nothing else ----
    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/checkout", payload: { plan: "pro" } })).statusCode, 401, "checkout requires a session");
    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: buyer.headers, payload: { plan: "free" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: buyer.headers, payload: { plan: "enterprise" } })).statusCode, 400);
    assert.equal(paddle.calls.length, 0, "a refused checkout never reaches the processor");

    const checkout = await app.inject({
      method: "POST",
      url: "/v1/billing/checkout",
      headers: buyer.headers,
      payload: { plan: "pro", priceId: "pri_attacker00000", price_id: "pri_attacker00000", amount: 1, currency: "IDR", entitlements: { "markets.daily": 999999 } }
    });
    assert.equal(checkout.statusCode, 200, checkout.body);
    const session = checkout.json();
    assert.ok(String(session.url).startsWith(`${CHECKOUT_URL}?_ptxn=txn_`), session.url);
    const transactionCall = paddle.calls.at(-1)!;
    assert.equal(transactionCall.path, "/transactions");
    assert.equal(transactionCall.authorization, `Bearer ${API_KEY}`);
    assert.equal(transactionCall.version, "1");
    assert.deepEqual(transactionCall.body!.items, [{ price_id: PRICE_PRO, quantity: 1 }]);
    const sent = JSON.stringify(transactionCall.body);
    assert.ok(
      !sent.includes("pri_attacker") && !sent.includes("IDR") && !sent.includes("999999") && !("amount" in transactionCall.body!),
      "client-supplied price, amount, currency and entitlements never reach the processor"
    );
    assert.equal((transactionCall.body!.custom_data as Record<string, unknown>).aegix_user_id, buyer.userId);
    assert.ok(!checkout.body.includes(API_KEY) && !checkout.body.includes(WEBHOOK_SECRET), "no secret in the checkout response");

    const change = await app.inject({ method: "POST", url: "/v1/billing/subscription/change", headers: buyer.headers, payload: { plan: "pro" } });
    assert.equal(change.statusCode, 409);
    assert.equal(change.json().code, "CHECKOUT_REQUIRED", "a plan is never granted outside checkout");

    // ---- Coming back from checkout proves nothing ----
    const returned = await subscriptionOf(buyer.headers);
    assert.equal(returned.status, "NONE");
    assert.equal(returned.plan.code, "free");

    // ---- Unsigned, forged or malformed webhooks change nothing ----
    const sub = paddle.complete(session.reference, at(10));
    const createdEvent = paddleEvent("subscription.created", sub, at(10));
    const createdBody = JSON.stringify(createdEvent);
    const refusals: Array<[string, number, Awaited<ReturnType<typeof deliver>>]> = [
      ["unsigned", 401, await deliver(app, createdEvent, { signature: null })],
      ["wrong secret", 401, await deliver(app, createdEvent, { secret: "not-the-webhook-secret" })],
      ["tampered body", 401, await deliver(app, null, { rawBody: createdBody.replace('"active"', '"trialing"'), signature: signatureFor(createdBody) })],
      ["expired timestamp", 401, await deliver(app, createdEvent, { timestamp: Math.floor(Date.now() / 1000) - 3600 })],
      ["future timestamp", 401, await deliver(app, createdEvent, { timestamp: Math.floor(Date.now() / 1000) + 3600 })],
      ["garbage signature", 401, await deliver(app, createdEvent, { signature: "ts=abc;h1=xyz" })],
      ["malformed json", 400, await deliver(app, null, { rawBody: "{not json" })],
      ["invalid envelope", 400, await deliver(app, { ...createdEvent, event_id: "nope" })],
      ["wrong content type", 415, await deliver(app, createdEvent, { contentType: "text/plain" })],
      ["oversized", 413, await deliver(app, { ...createdEvent, padding: "x".repeat(20_000) })]
    ];
    for (const [label, expected, response] of refusals) {
      assert.equal(response.statusCode, expected, `${label}: ${response.body}`);
    }
    assert.equal((await subscriptionOf(buyer.headers)).status, "NONE", "no refused webhook changed billing state");
    assert.deepEqual(await ledger(buyer.userId), []);

    // ---- Activation comes from the authenticated webhook ----
    const activation = await deliver(app, createdEvent);
    assert.equal(activation.statusCode, 200, activation.body);
    assert.equal(activation.json().outcome, "APPLIED");
    const active = await subscriptionOf(buyer.headers);
    assert.equal(active.status, "ACTIVE");
    assert.equal(active.plan.code, "pro");
    assert.equal(active.managedBy, "paddle");
    assert.equal(active.entitlements["markets.daily"], MARKETS_FREE_QUOTA * 10);

    // The paid feature is usable; a free identity stays restricted.
    for (let i = 0; i < MARKETS_FREE_QUOTA + 1; i++) {
      assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: buyer.headers })).statusCode, 200, `paid markets call ${i + 1}`);
    }
    for (let i = 0; i < MARKETS_FREE_QUOTA; i++) {
      assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: other.headers })).statusCode, 200, `free markets call ${i + 1}`);
    }
    assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: other.headers })).statusCode, 429, "a free identity keeps the free quota");

    // The paid plan covers two monitors (the free plan covers one).
    for (let i = 0; i < 2; i++) {
      const address = base58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
      assert.equal((await app.inject({ method: "POST", url: "/v1/me/saved", headers: buyer.headers, payload: { address } })).statusCode, 201);
      const monitor = await app.inject({ method: "POST", url: "/v1/me/monitors", headers: buyer.headers, payload: { address } });
      assert.equal(monitor.statusCode, 201, `paid plan covers monitor ${i + 1}: ${monitor.body}`);
      await sleep(20);
    }

    // ---- Idempotency and replay ----
    const duplicate = await deliver(app, createdEvent);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    const replay = await deliver(app, createdEvent, { timestamp: Math.floor(Date.now() / 1000) - 5 });
    assert.equal(replay.json().duplicate, true, "a replayed event id is absorbed even when re-signed");
    assert.equal((await deliver(app, paddleEvent("subscription.activated", sub, at(11)))).json().outcome, "UNCHANGED");
    assert.deepEqual(await ledger(buyer.userId), ["SUBSCRIPTION_CREATED"], "one ledger entry however often Paddle repeats itself");

    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: buyer.headers, payload: { plan: "team" } })).statusCode,
      409,
      "a second subscription cannot be bought over a live one"
    );

    // ---- Processor subscriptions this API did not start grant nothing ----
    const foreign = { ...structuredClone(sub), id: paddle.id("sub"), customer_id: paddle.id("ctm"), transaction_id: paddle.id("txn"), custom_data: null };
    assert.equal((await deliver(app, paddleEvent("subscription.created", foreign, at(12)))).json().outcome, "IGNORED");
    const forged = { ...structuredClone(foreign), id: paddle.id("sub"), custom_data: { aegix_user_id: other.userId, aegix_checkout: "guessed-token" } };
    assert.equal((await deliver(app, paddleEvent("subscription.created", forged, at(12)))).json().outcome, "IGNORED");
    assert.equal((await subscriptionOf(other.headers)).status, "NONE", "claiming a user id in the payload binds nothing");
    const unknownPrice = { ...structuredClone(sub), items: [{ price: { id: "pri_notinthecatalog00" } }] };
    assert.equal((await deliver(app, paddleEvent("subscription.updated", unknownPrice, at(13)))).json().outcome, "IGNORED");
    const unhandled = await deliver(app, paddleEvent("transaction.completed", { id: session.reference }, at(13)));
    assert.equal(unhandled.statusCode, 200);
    assert.equal(unhandled.json().outcome, "IGNORED", "an unhandled event type is acknowledged and ignored");
    assert.equal((await subscriptionOf(buyer.headers)).plan.code, "pro");

    // ---- Payment failure → PAST_DUE with grace; older events never revert it ----
    const failing = { ...structuredClone(sub), status: "past_due" };
    assert.equal((await deliver(app, paddleEvent("subscription.past_due", failing, at(20)))).json().outcome, "APPLIED");
    const inGrace = await subscriptionOf(buyer.headers);
    assert.equal(inGrace.status, "PAST_DUE");
    assert.equal(inGrace.plan.code, "pro", "paid limits hold through the grace window");
    assert.equal(Date.parse(inGrace.gracePeriodEnd), at(20).getTime() + 7 * 86_400_000);

    const olderActive = { ...structuredClone(sub), status: "active" };
    assert.equal((await deliver(app, paddleEvent("subscription.updated", olderActive, at(15)))).json().outcome, "STALE");
    assert.equal((await subscriptionOf(buyer.headers)).status, "PAST_DUE", "an older event never reverts a newer state");
    assert.equal((await deliver(app, paddleEvent("subscription.past_due", failing, at(25)))).json().outcome, "UNCHANGED");
    assert.equal((await subscriptionOf(buyer.headers)).gracePeriodEnd, inGrace.gracePeriodEnd, "a repeated failure never extends grace");
    assert.equal(
      (await deliver(app, paddleEvent("subscription.updated", olderActive, at(22)))).json().outcome,
      "STALE",
      "an event older than the newest observation is stale even when that observation changed nothing"
    );

    const graceSweep = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.deepEqual(await monitorStatuses(buyer.userId), ["ACTIVE", "ACTIVE"], "monitors keep paid coverage during grace");
    assert.ok(graceSweep.failed === 0, "the sweep ran cleanly");
    const dueLater = await repo.dueForLifecycle(new Date(Date.now() + 400 * 86_400_000), 10_000);
    assert.ok(!dueLater.some((row) => row.user_id === buyer.userId), "the sweep never renews or expires a processor-managed subscription");

    // ---- Recovery ----
    assert.equal((await deliver(app, paddleEvent("subscription.updated", olderActive, at(30)))).json().outcome, "APPLIED");
    const recovered = await subscriptionOf(buyer.headers);
    assert.equal(recovered.status, "ACTIVE");
    assert.equal(recovered.gracePeriodEnd, null);

    // ---- Customer portal: the caller's own processor customer only ----
    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/portal" })).statusCode, 401);
    const callsBefore = paddle.calls.length;
    const otherPortal = await app.inject({ method: "POST", url: "/v1/billing/portal", headers: other.headers });
    assert.equal(otherPortal.statusCode, 404);
    assert.equal(otherPortal.json().code, "NO_BILLING_ACCOUNT");
    assert.equal(paddle.calls.length, callsBefore, "an identity without a processor account never reaches the processor");
    const portal = await app.inject({ method: "POST", url: "/v1/billing/portal", headers: buyer.headers });
    assert.equal(portal.statusCode, 200, portal.body);
    assert.equal(paddle.calls.at(-1)!.path, `/customers/${sub.customer_id}/portal-sessions`);
    assert.deepEqual(paddle.calls.at(-1)!.body, { subscription_ids: [sub.id] });
    assert.ok(String(portal.json().url).includes(sub.customer_id));

    const otherCancel = await app.inject({ method: "POST", url: "/v1/billing/subscription/cancel", headers: other.headers, payload: {} });
    assert.equal(otherCancel.statusCode, 409, "another identity has nothing to cancel");
    assert.equal((await subscriptionOf(buyer.headers)).status, "ACTIVE", "and cannot touch this subscription");

    // ---- Cancel at period end → access continues → resume → cancel → Paddle ends it ----
    const cancel = await app.inject({ method: "POST", url: "/v1/billing/subscription/cancel", headers: buyer.headers, payload: {} });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(paddle.calls.at(-1)!.path, `/subscriptions/${sub.id}/cancel`);
    assert.deepEqual(paddle.calls.at(-1)!.body, { effective_from: "next_billing_period" });
    assert.equal(cancel.json().status, "CANCELED");
    assert.equal(cancel.json().cancelAtPeriodEnd, true);
    assert.equal((await subscriptionOf(buyer.headers)).plan.code, "pro", "access continues until the period ends");

    const scheduledState = paddle.subscriptions.get(sub.id)!;
    assert.equal(
      (await deliver(app, paddleEvent("subscription.updated", scheduledState, new Date(scheduledState.updated_at)))).json().outcome,
      "UNCHANGED",
      "Paddle's own webhook for the same change is absorbed"
    );

    await sleep(5);
    const resume = await app.inject({ method: "POST", url: "/v1/billing/subscription/resume", headers: buyer.headers });
    assert.equal(resume.statusCode, 200, resume.body);
    assert.equal(resume.json().status, "ACTIVE");
    assert.equal(paddle.calls.at(-1)!.method, "PATCH");
    assert.deepEqual(paddle.calls.at(-1)!.body, { scheduled_change: null });

    await sleep(5);
    const cancelAgain = await app.inject({ method: "POST", url: "/v1/billing/subscription/cancel", headers: buyer.headers, payload: {} });
    assert.equal(cancelAgain.json().status, "CANCELED");

    const before = await retained(buyer.userId);
    const endedAt = new Date(Date.now() + 5000);
    const ended = {
      ...structuredClone(paddle.subscriptions.get(sub.id)!),
      status: "canceled",
      scheduled_change: null,
      current_billing_period: null,
      canceled_at: endedAt.toISOString(),
      updated_at: endedAt.toISOString()
    };
    assert.equal((await deliver(app, paddleEvent("subscription.canceled", ended, endedAt))).json().outcome, "APPLIED");
    const expired = await subscriptionOf(buyer.headers);
    assert.equal(expired.status, "EXPIRED");
    assert.equal(expired.plan.code, "free");
    assert.equal(expired.entitlements["markets.daily"], MARKETS_FREE_QUOTA);
    assert.equal((await app.inject({ url: "/v1/markets/SOL", headers: buyer.headers })).statusCode, 429, "the free quota applies again");

    // ---- Monitor: uncovered monitors pause; nothing is deleted ----
    const lapsed = await runBillingLifecycle({ config, sql, logger: silentLogger() });
    assert.ok(lapsed.monitorsPaused >= 1, `the sweep paused the uncovered monitor (${lapsed.monitorsPaused})`);
    assert.deepEqual(await monitorStatuses(buyer.userId), ["ACTIVE", "ENTITLEMENT_PAUSED"]);
    assert.deepEqual(await retained(buyer.userId), before, "saved analyses, comparisons, monitors and profile survive expiry");

    assert.equal(
      (await deliver(app, paddleEvent("subscription.updated", olderActive, at(40)))).json().outcome,
      "STALE",
      "a late event never resurrects an ended subscription"
    );

    assert.deepEqual(await ledger(buyer.userId), [
      "SUBSCRIPTION_CREATED",
      "PAYMENT_FAILED",
      "PAYMENT_RECOVERED",
      "CANCELLATION_SCHEDULED",
      "CANCELLATION_REVOKED",
      "CANCELLATION_SCHEDULED",
      "SUBSCRIPTION_EXPIRED"
    ]);
    assert.deepEqual(await ledger(other.userId), [], "no ledger entry for the other identity");

    // ---- Nothing secret reached a log line ----
    const logText = logged.join("");
    assert.ok(logText.includes("billing webhook processed"), "the log capture saw the API's log lines");
    for (const secret of [API_KEY, WEBHOOK_SECRET, signPaddleWebhook(WEBHOOK_SECRET, 0, "")]) {
      assert.ok(!logText.includes(secret), "no processor secret is logged");
    }
    assert.ok(!/h1=[0-9a-f]{64}/.test(logText), "no webhook signature is logged");

    console.log("D11 payment processor: checkout, portal, signed webhooks, idempotency, ordering, lifecycle and retention: PASS");
  } finally {
    await app.close();
    await cleanup(sql, created);
    await sql.end();
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

function silentLogger(): AegixLogger {
  const noop = () => {};
  return { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, child: () => silentLogger() };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : "D11 provider E2E failure");
  process.exitCode = 1;
});
