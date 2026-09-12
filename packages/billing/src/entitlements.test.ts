import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCatalog, freeEntitlements, type EntitlementBaseline } from "./catalog.js";
import { effectivePlanCode, resolveEntitlements } from "./entitlements.js";
import type { SubscriptionState } from "./types.js";

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
const now = new Date("2026-09-13T12:00:00.000Z");

function sub(patch: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    planCode: "pro",
    status: "ACTIVE",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    gracePeriodEnd: null,
    trialEnd: null,
    ...patch
  };
}

test("no subscription resolves to the free baseline — D11 changes nothing for existing identities", () => {
  const resolved = resolveEntitlements(catalog, null, now);
  assert.equal(resolved.planCode, "free");
  assert.equal(resolved.status, "NONE");
  assert.equal(resolved.degraded, false);
  assert.deepEqual(resolved.entitlements, freeEntitlements(baseline));
  // The reporting period for an identity with no subscription is the UTC month.
  assert.equal(resolved.period.start, "2026-09-01T00:00:00.000Z");
  assert.equal(resolved.period.end, "2026-10-01T00:00:00.000Z");
});

test("ACTIVE and TRIALING resolve to the subscribed plan", () => {
  assert.equal(resolveEntitlements(catalog, sub(), now).entitlements["analysis.daily"], 100);
  const trial = sub({ status: "TRIALING", trialEnd: "2026-09-20T00:00:00.000Z" });
  assert.equal(resolveEntitlements(catalog, trial, now).entitlements["analysis.daily"], 100);
});

test("an expired trial degrades even if the row was never transitioned", () => {
  const stale = sub({ status: "TRIALING", trialEnd: "2026-09-10T00:00:00.000Z" });
  const resolved = resolveEntitlements(catalog, stale, now);
  assert.equal(resolved.planCode, "free");
  assert.equal(resolved.subscribedPlanCode, "pro");
  assert.equal(resolved.degraded, true);
});

test("PAST_DUE holds entitlements through the grace window, then degrades", () => {
  const inGrace = sub({ status: "PAST_DUE", gracePeriodEnd: "2026-09-20T00:00:00.000Z" });
  assert.equal(effectivePlanCode(inGrace, now), "pro");
  const pastGrace = sub({ status: "PAST_DUE", gracePeriodEnd: "2026-09-01T00:00:00.000Z" });
  assert.equal(effectivePlanCode(pastGrace, now), "free");
  const noGrace = sub({ status: "PAST_DUE", gracePeriodEnd: null });
  assert.equal(effectivePlanCode(noGrace, now), "free");
});

test("a scheduled cancellation is honoured to the last instant of the paid period", () => {
  const canceled = sub({ status: "CANCELED", cancelAtPeriodEnd: true });
  assert.equal(effectivePlanCode(canceled, now), "pro");
  assert.equal(effectivePlanCode(canceled, new Date("2026-10-01T00:00:00.000Z")), "free");
  assert.equal(effectivePlanCode(canceled, new Date("2026-09-30T23:59:59.999Z")), "pro");
});

test("EXPIRED resolves to free", () => {
  assert.equal(effectivePlanCode(sub({ status: "EXPIRED" }), now), "free");
});

test("a late renewal is never a customer-visible downgrade", () => {
  const stale = sub({ currentPeriodEnd: "2026-09-05T00:00:00.000Z" });
  assert.equal(effectivePlanCode(stale, now), "pro");
});

test("entitlements never resolve below the free baseline", () => {
  // A catalog where a paid plan is accidentally worse than free must still
  // not leave a paying customer worse off than a free identity.
  const broken = catalog.map((plan) =>
    plan.code === "pro" ? { ...plan, entitlements: { ...plan.entitlements, "analysis.daily": 1 } } : plan
  );
  const resolved = resolveEntitlements(broken, sub(), now);
  assert.equal(resolved.entitlements["analysis.daily"], baseline.analysisDaily);
});

test("an unparsable boundary degrades rather than throwing", () => {
  const broken = sub({ status: "CANCELED", currentPeriodEnd: "not-a-date" });
  assert.equal(effectivePlanCode(broken, now), "free");
});

test("the resolved period follows the subscription, not the calendar", () => {
  const resolved = resolveEntitlements(catalog, sub({ currentPeriodStart: "2026-09-07T00:00:00.000Z" }), now);
  assert.equal(resolved.period.start, "2026-09-07T00:00:00.000Z");
});
