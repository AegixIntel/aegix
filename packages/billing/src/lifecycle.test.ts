import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCatalog, findPlan, type EntitlementBaseline } from "./catalog.js";
import { nextLifecycleDeadline, transition } from "./lifecycle.js";
import { BillingError, type PlanDefinition, type SubscriptionState } from "./types.js";

const baseline: EntitlementBaseline = {
  analysisDaily: 10,
  compareDaily: 50,
  askDaily: 25,
  marketsDaily: 200,
  monitorsActive: 3,
  apiKeysActive: 10,
  webhooksActive: 5,
  apiDaily: 500
};

const catalog = buildPlanCatalog(baseline, "USD");
const free = findPlan(catalog, "free") as PlanDefinition;
const pro = findPlan(catalog, "pro") as PlanDefinition;
const team = findPlan(catalog, "team") as PlanDefinition;
const now = new Date("2026-09-13T12:00:00.000Z");

function live(patch: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    planCode: "pro",
    status: "ACTIVE",
    currentPeriodStart: "2026-09-13T12:00:00.000Z",
    currentPeriodEnd: "2026-10-13T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    gracePeriodEnd: null,
    trialEnd: null,
    ...patch
  };
}

test("SUBSCRIBE opens a period and emits exactly one creation event", () => {
  const result = transition({ subscription: null, action: "SUBSCRIBE", plan: pro, now });
  assert.equal(result.subscription.status, "ACTIVE");
  assert.equal(result.subscription.planCode, "pro");
  assert.equal(result.subscription.currentPeriodStart, "2026-09-13T12:00:00.000Z");
  assert.equal(result.subscription.currentPeriodEnd, "2026-10-13T12:00:00.000Z");
  assert.equal(result.event.type, "SUBSCRIPTION_CREATED");
  assert.equal(result.event.fromStatus, "NONE");
  assert.equal(result.event.toStatus, "ACTIVE");
});

test("SUBSCRIBE with a trial opens in TRIALING", () => {
  const result = transition({ subscription: null, action: "SUBSCRIBE", plan: pro, now, trialDays: 14 });
  assert.equal(result.subscription.status, "TRIALING");
  assert.equal(result.subscription.trialEnd, "2026-09-27T12:00:00.000Z");
});

test("the free plan cannot be subscribed to", () => {
  assert.throws(
    () => transition({ subscription: null, action: "SUBSCRIBE", plan: free, now }),
    (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
  );
});

test("a retired plan cannot be subscribed to or changed to", () => {
  const retired: PlanDefinition = { ...pro, status: "RETIRED" };
  for (const action of ["SUBSCRIBE", "CHANGE_PLAN"] as const) {
    assert.throws(
      () => transition({ subscription: action === "SUBSCRIBE" ? null : live(), action, plan: retired, now }),
      (error: unknown) => error instanceof BillingError && error.code === "RETIRED_PLAN"
    );
  }
});

test("SUBSCRIBE is rejected while a subscription is live", () => {
  assert.throws(
    () => transition({ subscription: live(), action: "SUBSCRIBE", plan: team, now }),
    (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
  );
});

test("SUBSCRIBE is allowed again after expiry", () => {
  const result = transition({ subscription: live({ status: "EXPIRED" }), action: "SUBSCRIBE", plan: team, now });
  assert.equal(result.subscription.status, "ACTIVE");
  assert.equal(result.subscription.planCode, "team");
});

test("CHANGE_PLAN preserves the billing period", () => {
  const current = live();
  const result = transition({ subscription: current, action: "CHANGE_PLAN", plan: team, now });
  assert.equal(result.subscription.planCode, "team");
  assert.equal(result.subscription.currentPeriodStart, current.currentPeriodStart);
  assert.equal(result.subscription.currentPeriodEnd, current.currentPeriodEnd);
  assert.equal(result.event.type, "PLAN_CHANGED");
  assert.equal(result.event.fromPlan, "pro");
  assert.equal(result.event.toPlan, "team");
});

test("CHANGE_PLAN to the same plan, or to free, is rejected", () => {
  for (const plan of [pro, free]) {
    assert.throws(
      () => transition({ subscription: live(), action: "CHANGE_PLAN", plan, now }),
      (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
    );
  }
});

test("RENEW advances to the next period", () => {
  const result = transition({ subscription: live(), action: "RENEW", plan: pro, now });
  assert.equal(result.subscription.status, "ACTIVE");
  assert.equal(result.subscription.currentPeriodStart, "2026-10-13T12:00:00.000Z");
  assert.equal(result.subscription.currentPeriodEnd, "2026-11-13T12:00:00.000Z");
  assert.equal(result.event.type, "SUBSCRIPTION_RENEWED");
});

test("RENEW of a subscription scheduled for cancellation ends it", () => {
  const result = transition({ subscription: live({ status: "CANCELED", cancelAtPeriodEnd: true }), action: "RENEW", plan: pro, now });
  assert.equal(result.subscription.status, "EXPIRED");
  assert.equal(result.event.type, "SUBSCRIPTION_EXPIRED");
  assert.equal(result.event.detail.reason, "CANCELLED_AT_PERIOD_END");
});

test("CANCEL schedules, RESUME revokes", () => {
  const canceled = transition({ subscription: live(), action: "CANCEL", plan: pro, now });
  assert.equal(canceled.subscription.status, "CANCELED");
  assert.equal(canceled.subscription.cancelAtPeriodEnd, true);
  assert.equal(canceled.event.type, "CANCELLATION_SCHEDULED");
  assert.equal(canceled.event.detail.effectiveAt, "2026-10-13T12:00:00.000Z");

  const resumed = transition({ subscription: canceled.subscription, action: "RESUME", plan: pro, now });
  assert.equal(resumed.subscription.status, "ACTIVE");
  assert.equal(resumed.subscription.cancelAtPeriodEnd, false);
  assert.equal(resumed.event.type, "CANCELLATION_REVOKED");
});

test("RESUME after the period has ended is rejected", () => {
  const ended = live({ status: "CANCELED", cancelAtPeriodEnd: true, currentPeriodEnd: "2026-09-01T00:00:00.000Z" });
  assert.throws(
    () => transition({ subscription: ended, action: "RESUME", plan: pro, now }),
    (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
  );
});

test("CANCEL_IMMEDIATELY ends the period at the cancellation instant", () => {
  const result = transition({ subscription: live(), action: "CANCEL_IMMEDIATELY", plan: pro, now });
  assert.equal(result.subscription.status, "EXPIRED");
  assert.equal(result.subscription.currentPeriodEnd, now.toISOString());
  assert.equal(result.event.type, "SUBSCRIPTION_CANCELED");
});

test("repeated payment failures never extend the grace window", () => {
  const first = transition({ subscription: live(), action: "PAYMENT_FAILED", plan: pro, now, graceDays: 7 });
  assert.equal(first.subscription.status, "PAST_DUE");
  assert.equal(first.subscription.gracePeriodEnd, "2026-09-20T12:00:00.000Z");

  const later = new Date("2026-09-18T12:00:00.000Z");
  const second = transition({ subscription: first.subscription, action: "PAYMENT_FAILED", plan: pro, now: later, graceDays: 7 });
  assert.equal(second.subscription.gracePeriodEnd, "2026-09-20T12:00:00.000Z");
});

test("PAYMENT_RECOVERED clears the grace window", () => {
  const pastDue = live({ status: "PAST_DUE", gracePeriodEnd: "2026-09-20T12:00:00.000Z" });
  const result = transition({ subscription: pastDue, action: "PAYMENT_RECOVERED", plan: pro, now });
  assert.equal(result.subscription.status, "ACTIVE");
  assert.equal(result.subscription.gracePeriodEnd, null);
});

test("PAYMENT_RECOVERED is rejected unless the subscription is PAST_DUE", () => {
  assert.throws(
    () => transition({ subscription: live(), action: "PAYMENT_RECOVERED", plan: pro, now }),
    (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
  );
});

test("every action against a missing subscription is rejected", () => {
  for (const action of ["CHANGE_PLAN", "RENEW", "CANCEL", "RESUME", "CANCEL_IMMEDIATELY", "PAYMENT_FAILED", "PAYMENT_RECOVERED", "EXPIRE"] as const) {
    assert.throws(
      () => transition({ subscription: null, action, plan: pro, now }),
      (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION",
      action
    );
  }
});

test("EXPIRE is terminal", () => {
  const expired = transition({ subscription: live(), action: "EXPIRE", plan: pro, now });
  assert.equal(expired.subscription.status, "EXPIRED");
  assert.throws(
    () => transition({ subscription: expired.subscription, action: "EXPIRE", plan: pro, now }),
    (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
  );
});

test("nextLifecycleDeadline picks the earliest bound", () => {
  assert.equal(nextLifecycleDeadline(live()), "2026-10-13T12:00:00.000Z");
  assert.equal(
    nextLifecycleDeadline(live({ status: "PAST_DUE", gracePeriodEnd: "2026-09-20T12:00:00.000Z" })),
    "2026-09-20T12:00:00.000Z"
  );
  assert.equal(
    nextLifecycleDeadline(live({ status: "TRIALING", trialEnd: "2026-09-27T12:00:00.000Z" })),
    "2026-09-27T12:00:00.000Z"
  );
});
