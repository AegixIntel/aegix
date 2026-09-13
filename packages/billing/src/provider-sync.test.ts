import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCatalog } from "./catalog.js";
import { resolveEntitlements } from "./entitlements.js";
import {
  reconcileProviderSubscription,
  type ProviderBinding,
  type ProviderSubscriptionSnapshot
} from "./provider-sync.js";
import type { SubscriptionState } from "./types.js";

const catalog = buildPlanCatalog(
  {
    analysisDaily: 10,
    compareDaily: 50,
    askDaily: 25,
    marketsDaily: 200,
    monitorsActive: 3,
    apiKeysActive: 10,
    webhooksActive: 5,
    apiDaily: 500
  },
  "USD"
);

const PERIOD_START = "2026-09-01T00:00:00.000Z";
const PERIOD_END = "2026-10-01T00:00:00.000Z";

function snapshot(patch: Partial<ProviderSubscriptionSnapshot> = {}): ProviderSubscriptionSnapshot {
  return {
    provider: "paddle",
    subscriptionRef: "sub_a",
    customerRef: "ctm_a",
    planCode: "pro",
    status: "ACTIVE",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    trialEnd: null,
    observedAt: "2026-09-01T00:00:00.000Z",
    ...patch
  };
}

const bound = (observedAt: string, subscriptionRef = "sub_a"): ProviderBinding => ({
  provider: "paddle",
  subscriptionRef,
  observedAt
});

function applied(decision: ReturnType<typeof reconcileProviderSubscription>) {
  assert.equal(decision.kind, "apply", `expected apply, got ${decision.kind}`);
  if (decision.kind !== "apply") throw new Error("unreachable");
  return decision;
}

test("a first paid snapshot creates the subscription", () => {
  const result = applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 }));
  assert.equal(result.event.type, "SUBSCRIPTION_CREATED");
  assert.equal(result.event.fromStatus, "NONE");
  assert.equal(result.subscription.status, "ACTIVE");
  assert.equal(result.subscription.planCode, "pro");
  assert.equal(result.subscription.currentPeriodEnd, PERIOD_END);
  assert.equal(resolveEntitlements(catalog, result.subscription, new Date("2026-09-02T00:00:00Z")).planCode, "pro");
});

test("the same state reported again changes nothing", () => {
  const first = applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 }));
  const again = reconcileProviderSubscription({
    current: first.subscription,
    binding: bound("2026-09-01T00:00:00.000Z"),
    snapshot: snapshot({ observedAt: "2026-09-01T00:05:00.000Z" }),
    graceDays: 7
  });
  assert.deepEqual(again, { kind: "unchanged" });
});

test("an older snapshot never reverts a newer state", () => {
  const pastDue = applied(
    reconcileProviderSubscription({
      current: applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 })).subscription,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ status: "PAST_DUE", observedAt: "2026-09-20T00:00:00.000Z" }),
      graceDays: 7
    })
  ).subscription;
  const late = reconcileProviderSubscription({
    current: pastDue,
    binding: bound("2026-09-20T00:00:00.000Z"),
    snapshot: snapshot({ status: "ACTIVE", observedAt: "2026-09-10T00:00:00.000Z" }),
    graceDays: 7
  });
  assert.deepEqual(late, { kind: "stale" });
});

test("a payment failure opens a grace window that repeated failures never extend", () => {
  const active = applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 })).subscription;
  const failed = applied(
    reconcileProviderSubscription({
      current: active,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ status: "PAST_DUE", observedAt: "2026-10-01T00:00:00.000Z" }),
      graceDays: 7
    })
  );
  assert.equal(failed.event.type, "PAYMENT_FAILED");
  assert.equal(failed.subscription.gracePeriodEnd, "2026-10-08T00:00:00.000Z");
  assert.equal(resolveEntitlements(catalog, failed.subscription, new Date("2026-10-05T00:00:00Z")).planCode, "pro", "paid during grace");
  assert.equal(resolveEntitlements(catalog, failed.subscription, new Date("2026-10-09T00:00:00Z")).planCode, "free", "free after grace");

  const retryFailed = reconcileProviderSubscription({
    current: failed.subscription,
    binding: bound("2026-10-01T00:00:00.000Z"),
    snapshot: snapshot({ status: "PAST_DUE", observedAt: "2026-10-04T00:00:00.000Z" }),
    graceDays: 7
  });
  assert.deepEqual(retryFailed, { kind: "unchanged" }, "the grace window stays anchored to the first failure");

  const recovered = applied(
    reconcileProviderSubscription({
      current: failed.subscription,
      binding: bound("2026-10-04T00:00:00.000Z"),
      snapshot: snapshot({ status: "ACTIVE", observedAt: "2026-10-05T00:00:00.000Z" }),
      graceDays: 7
    })
  );
  assert.equal(recovered.event.type, "PAYMENT_RECOVERED");
  assert.equal(recovered.subscription.gracePeriodEnd, null);
});

test("cancel at period end keeps access until the processor ends it", () => {
  const active = applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 })).subscription;
  const scheduled = applied(
    reconcileProviderSubscription({
      current: active,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ status: "CANCELED", observedAt: "2026-09-05T00:00:00.000Z" }),
      graceDays: 7
    })
  );
  assert.equal(scheduled.event.type, "CANCELLATION_SCHEDULED");
  assert.equal(scheduled.subscription.cancelAtPeriodEnd, true);
  assert.equal(resolveEntitlements(catalog, scheduled.subscription, new Date("2026-09-20T00:00:00Z")).planCode, "pro");

  const revoked = applied(
    reconcileProviderSubscription({
      current: scheduled.subscription,
      binding: bound("2026-09-05T00:00:00.000Z"),
      snapshot: snapshot({ status: "ACTIVE", observedAt: "2026-09-06T00:00:00.000Z" }),
      graceDays: 7
    })
  );
  assert.equal(revoked.event.type, "CANCELLATION_REVOKED");

  const ended = applied(
    reconcileProviderSubscription({
      current: scheduled.subscription,
      binding: bound("2026-09-05T00:00:00.000Z"),
      snapshot: snapshot({ status: "EXPIRED", periodStart: PERIOD_END, periodEnd: PERIOD_END, observedAt: PERIOD_END }),
      graceDays: 7
    })
  );
  assert.equal(ended.event.type, "SUBSCRIPTION_EXPIRED");
  assert.equal(ended.subscription.status, "EXPIRED");
  assert.equal(ended.subscription.currentPeriodStart, PERIOD_START, "the ended subscription keeps its last period");
  assert.equal(resolveEntitlements(catalog, ended.subscription, new Date("2026-10-02T00:00:00Z")).planCode, "free");
});

test("an active subscription ended by the processor is recorded as canceled", () => {
  const active = applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 })).subscription;
  const ended = applied(
    reconcileProviderSubscription({
      current: active,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ status: "EXPIRED", periodEnd: "2026-09-03T00:00:00.000Z", observedAt: "2026-09-03T00:00:00.000Z" }),
      graceDays: 7
    })
  );
  assert.equal(ended.event.type, "SUBSCRIPTION_CANCELED");
});

test("renewal and plan changes are labelled as such", () => {
  const active = applied(reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 })).subscription;
  const renewed = applied(
    reconcileProviderSubscription({
      current: active,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ periodStart: PERIOD_END, periodEnd: "2026-11-01T00:00:00.000Z", observedAt: PERIOD_END }),
      graceDays: 7
    })
  );
  assert.equal(renewed.event.type, "SUBSCRIPTION_RENEWED");
  const changed = applied(
    reconcileProviderSubscription({
      current: active,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ planCode: "team", observedAt: "2026-09-02T00:00:00.000Z" }),
      graceDays: 7
    })
  );
  assert.equal(changed.event.type, "PLAN_CHANGED");
});

test("nothing unpaid, unbound or superseded grants anything", () => {
  assert.deepEqual(
    reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot({ status: "INCOMPLETE" }), graceDays: 7 }),
    { kind: "ignored", reason: "INCOMPLETE" }
  );
  assert.deepEqual(
    reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot({ status: "EXPIRED" }), graceDays: 7 }),
    { kind: "ignored", reason: "NOT_BOUND" }
  );

  const live: SubscriptionState = applied(
    reconcileProviderSubscription({ current: null, binding: null, snapshot: snapshot(), graceDays: 7 })
  ).subscription;
  assert.deepEqual(
    reconcileProviderSubscription({
      current: live,
      binding: bound("2026-09-01T00:00:00.000Z"),
      snapshot: snapshot({ subscriptionRef: "sub_b", observedAt: "2026-09-09T00:00:00.000Z" }),
      graceDays: 7
    }),
    { kind: "ignored", reason: "SUPERSEDED" },
    "a second processor subscription never displaces the live one"
  );
});

test("a paid subscription takes over from a live operator grant", () => {
  const grant: SubscriptionState = {
    planCode: "pro",
    status: "ACTIVE",
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    gracePeriodEnd: null,
    trialEnd: null
  };
  const result = applied(
    reconcileProviderSubscription({
      current: grant,
      binding: { provider: "manual", subscriptionRef: null, observedAt: null },
      snapshot: snapshot({ planCode: "team" }),
      graceDays: 7
    })
  );
  assert.equal(result.event.type, "SUBSCRIPTION_CREATED");
  assert.equal(result.subscription.planCode, "team");
});
