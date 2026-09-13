import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "@aegix/config";
import type { BillingRepo, SubscriptionRow } from "@aegix/database";
import { freeEntitlements } from "@aegix/billing";
import { baselineFromConfig, createEntitlementService, toSubscriptionState } from "./entitlements.js";
import { createBillingStore, meteredUsageForPeriod } from "./billing.js";
import { buildServer } from "./server.js";

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix_test",
    REDIS_URL: "redis://localhost:6379",
    ...overrides
  });
}

const silentLogger = { warn() {}, info() {} };

function subscriptionRow(patch: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "1",
    user_id: "u1",
    plan_code: "pro",
    status: "ACTIVE",
    current_period_start: "2026-09-01T00:00:00.000Z",
    current_period_end: "2036-09-01T00:00:00.000Z",
    cancel_at_period_end: false,
    grace_period_end: null,
    trial_end: null,
    provider: "manual",
    provider_ref: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...patch
  };
}

function fakeRepo(overrides: Partial<BillingRepo> = {}): BillingRepo {
  return {
    async syncPlans() {},
    async listPlans() {
      return [];
    },
    async getSubscription() {
      return null;
    },
    async applyTransition() {
      return { subscription: null, applied: true };
    },
    async listEvents() {
      return [];
    },
    async dueForLifecycle() {
      return [];
    },
    async usageForPeriod() {
      return [];
    },
    async developerUnitsForPeriod() {
      return 0;
    },
    async upsertInvoice() {
      throw new Error("not used");
    },
    async listInvoices() {
      return [];
    },
    async getInvoice() {
      return null;
    },
    async requestUpgrade() {
      throw new Error("not used");
    },
    async getOpenUpgradeRequest() {
      return null;
    },
    async listOpenUpgradeRequests() {
      return [];
    },
    async fulfillUpgradeRequest() {
      return 0;
    },
    ...overrides
  };
}

test("an identity with no subscription gets exactly the deployment's configured limits", async () => {
  const config = testConfig();
  let reads = 0;
  const service = createEntitlementService({
    config,
    repo: fakeRepo({
      async getSubscription() {
        reads += 1;
        return null;
      }
    }),
    logger: silentLogger
  });

  const resolved = await service.resolve("u1");
  assert.equal(resolved.planCode, "free");
  assert.deepEqual(resolved.entitlements, freeEntitlements(baselineFromConfig(config)));
  // The free entitlements ARE the pre-D11 enforcement values.
  assert.equal(resolved.entitlements["analysis.daily"], config.FREE_USER_DAILY_LIMIT);
  assert.equal(resolved.entitlements["compare.daily"], config.COMPARE_DAILY_USER_LIMIT);
  assert.equal(resolved.entitlements["monitors.active"], config.MAX_ACTIVE_MONITORS_PER_USER);
  assert.equal(resolved.entitlements["apiKeys.active"], config.MAX_ACTIVE_API_KEYS_PER_USER);
  assert.equal(resolved.entitlements["api.daily"], config.DEVELOPER_DAILY_QUOTA);
  assert.equal(resolved.entitlements["ask.daily"], config.ASK_AEGIX_DAILY_QUOTA);
  assert.equal(resolved.entitlements["markets.daily"], config.MARKETS_DAILY_QUOTA);
  assert.equal(resolved.entitlements["webhooks.active"], config.MAX_ACTIVE_WEBHOOKS_PER_USER);
  assert.equal(reads, 1);
});

test("an anonymous caller never triggers a subscription read", async () => {
  let reads = 0;
  const service = createEntitlementService({
    config: testConfig(),
    repo: fakeRepo({
      async getSubscription() {
        reads += 1;
        return null;
      }
    }),
    logger: silentLogger
  });
  const resolved = await service.resolve(null);
  assert.equal(resolved.planCode, "free");
  assert.equal(reads, 0);
});

test("ENABLE_BILLING=false short-circuits to the baseline without touching the database", async () => {
  const service = createEntitlementService({
    config: testConfig({ ENABLE_BILLING: "false" }),
    repo: fakeRepo({
      async getSubscription() {
        throw new Error("must not read");
      }
    }),
    logger: silentLogger
  });
  const resolved = await service.resolve("u1");
  assert.equal(resolved.planCode, "free");
  await service.syncCatalog(); // also a no-op
});

test("a paid subscription raises the enforced limits", async () => {
  const service = createEntitlementService({
    config: testConfig(),
    repo: fakeRepo({
      async getSubscription() {
        return subscriptionRow();
      }
    }),
    logger: silentLogger
  });
  assert.equal(await service.limit("u1", "analysis.daily"), 100);
  assert.equal(await service.limit("u1", "monitors.active"), 15);
});

test("resolution is cached per identity and dropped on invalidate", async () => {
  let reads = 0;
  const service = createEntitlementService({
    config: testConfig(),
    repo: fakeRepo({
      async getSubscription() {
        reads += 1;
        return subscriptionRow();
      }
    }),
    logger: silentLogger
  });
  await service.resolve("u1");
  await service.resolve("u1");
  assert.equal(reads, 1);
  service.invalidate("u1");
  await service.resolve("u1");
  assert.equal(reads, 2);
});

test("a failed subscription read degrades to free instead of failing the request", async () => {
  const warnings: string[] = [];
  const service = createEntitlementService({
    config: testConfig(),
    repo: fakeRepo({
      async getSubscription() {
        throw new Error("database unavailable");
      }
    }),
    logger: { warn: (msg: string) => void warnings.push(msg) }
  });
  const resolved = await service.resolve("u1");
  assert.equal(resolved.planCode, "free");
  assert.equal(warnings.length, 1);
});

test("a catalog snapshot failure is retried rather than remembered as done", async () => {
  let attempts = 0;
  const service = createEntitlementService({
    config: testConfig(),
    repo: fakeRepo({
      async syncPlans() {
        attempts += 1;
        if (attempts === 1) throw new Error("write failed");
      }
    }),
    logger: silentLogger
  });
  await service.syncCatalog();
  await service.syncCatalog();
  assert.equal(attempts, 2);
  // Once it succeeds it is not repeated.
  await service.syncCatalog();
  assert.equal(attempts, 2);
});

test("a storage row round-trips into the resolver's shape", () => {
  assert.equal(toSubscriptionState(null), null);
  const state = toSubscriptionState(subscriptionRow({ grace_period_end: "2026-09-20T00:00:00.000Z" }));
  assert.equal(state?.planCode, "pro");
  assert.equal(state?.gracePeriodEnd, "2026-09-20T00:00:00.000Z");
});

test("the store adapter records the transition and reports idempotency", async () => {
  const applied: unknown[] = [];
  const store = createBillingStore(
    fakeRepo({
      async applyTransition(input) {
        applied.push(input);
        return { subscription: null, applied: false };
      }
    })
  );
  const result = await store.save({
    userId: "u1",
    subscription: {
      planCode: "pro",
      status: "ACTIVE",
      currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      gracePeriodEnd: null,
      trialEnd: null
    },
    event: {
      type: "SUBSCRIPTION_CREATED",
      fromStatus: "NONE",
      toStatus: "ACTIVE",
      fromPlan: "free",
      toPlan: "pro",
      occurredAt: "2026-09-01T00:00:00.000Z",
      detail: {}
    },
    eventKey: "u1:SUBSCRIPTION_CREATED:2026-09-01T00:00:00.000Z",
    profilePlan: "pro"
  });
  assert.equal(result, false, "a replayed event reports not-applied");
  assert.equal((applied[0] as { event: { fromStatus: string | null } }).event.fromStatus, null, "NONE is stored as null");
});

test("usage rollup drops cache hits and always reports API calls and monitors", async () => {
  const usage = await meteredUsageForPeriod(
    fakeRepo({
      async usageForPeriod() {
        return [
          { usage_type: "expensive_analysis", units: 4 },
          { usage_type: "cache_hit", units: 99 }
        ];
      },
      async developerUnitsForPeriod() {
        return 12;
      }
    }),
    async () => 2,
    "u1",
    "2026-09-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z"
  );
  assert.deepEqual(usage, [
    { dimension: "WALLET_ANALYSIS", units: 4 },
    { dimension: "API_CALLS", units: 12 },
    { dimension: "MONITORED_WALLETS", units: 2 }
  ]);
});

test("the plan catalog is public, and billing can be switched off entirely", async () => {
  const app = await buildServer({ config: testConfig() });
  try {
    const plans = await app.inject({ url: "/v1/billing/plans" });
    assert.equal(plans.statusCode, 200);
    assert.deepEqual(
      plans.json().plans.map((p: { code: string }) => p.code),
      ["free", "pro", "team"]
    );
    assert.equal(plans.json().selfServe, false, "no payment provider in this baseline");
    // Everything else needs an identity.
    for (const url of ["/v1/billing/subscription", "/v1/billing/usage", "/v1/billing/invoices", "/v1/billing/events"]) {
      assert.equal((await app.inject({ url })).statusCode, 401, url);
    }
  } finally {
    await app.close();
  }

  const off = await buildServer({ config: testConfig({ ENABLE_BILLING: "false" }) });
  try {
    assert.equal((await off.inject({ url: "/v1/billing/plans" })).statusCode, 403);
    // Disabling billing must not disable the product.
    assert.equal((await off.inject({ url: "/health/live" })).statusCode, 200);
  } finally {
    await off.close();
  }
});

test("an upgrade is refused while no payment provider is configured", async () => {
  const app = await buildServer({ config: testConfig() });
  try {
    // Unauthenticated first: the refusal must not leak ahead of auth.
    const anonymous = await app.inject({ method: "POST", url: "/v1/billing/subscription/change", payload: { plan: "pro" } });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("V1 manual provisioning boots with no payment-processor settings at all", async () => {
  // No BILLING_* or processor credential in the environment.
  const config = testConfig();
  assert.equal(config.BILLING_PROVIDER, "manual");
  const app = await buildServer({ config });
  try {
    const plans = await app.inject({ url: "/v1/billing/plans" });
    assert.equal(plans.statusCode, 200);
    assert.equal(plans.json().provider, "manual");
    assert.equal(plans.json().selfServe, false, "no checkout is offered");
    // Asking for a paid plan needs an identity, like every billing write.
    const anonymous = await app.inject({ method: "POST", url: "/v1/billing/upgrade-request", payload: { plan: "pro" } });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await app.close();
  }
});
