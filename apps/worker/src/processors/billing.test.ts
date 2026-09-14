import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubscriptionRow } from "@aegix/database";
import { decideLifecycleAction, decideMonitorEntitlement } from "./billing.js";

const now = new Date("2026-09-13T12:00:00.000Z");

function row(patch: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "1",
    user_id: "u1",
    plan_code: "pro",
    status: "ACTIVE",
    current_period_start: "2026-08-13T12:00:00.000Z",
    current_period_end: "2026-09-13T12:00:00.000Z",
    cancel_at_period_end: false,
    grace_period_end: null,
    trial_end: null,
    provider: "manual",
    provider_ref: null,
    created_at: "2026-08-13T12:00:00.000Z",
    updated_at: "2026-08-13T12:00:00.000Z",
    ...patch
  };
}

test("a manually provisioned elapsed period ends unpaid, keyed on the boundary it crossed", () => {
  // Time passing is not payment: without an operator-confirmed invoice the
  // next period must not be granted.
  const decision = decideLifecycleAction(row(), now);
  assert.deepEqual(decision, {
    action: "EXPIRE",
    boundary: "2026-09-13T12:00:00.000Z",
    reason: "PERIOD_ELAPSED_UNPAID"
  });
});

test("a processor-managed elapsed period still renews automatically", () => {
  // Removing manual auto-renewal must not touch what a payment processor
  // already collected for.
  const decision = decideLifecycleAction(row({ provider: "stripe", provider_ref: "sub_123" }), now);
  assert.deepEqual(decision, {
    action: "RENEW",
    boundary: "2026-09-13T12:00:00.000Z",
    reason: "PERIOD_ELAPSED"
  });
});

test("a period that has not elapsed is left alone", () => {
  assert.equal(decideLifecycleAction(row({ current_period_end: "2026-10-13T12:00:00.000Z" }), now), null);
});

test("a past-due subscription never renews, even once its period has elapsed", () => {
  // Renewing would advance the period and clear the payment failure. Inside
  // the grace window the sweep does nothing: it recovers or it expires.
  const inGrace = row({ status: "PAST_DUE", grace_period_end: "2026-09-20T12:00:00.000Z" });
  assert.equal(decideLifecycleAction(inGrace, now), null);
});

test("a closed grace window ends the subscription", () => {
  const decision = decideLifecycleAction(
    row({ status: "PAST_DUE", grace_period_end: "2026-09-12T12:00:00.000Z" }),
    now
  );
  assert.deepEqual(decision, {
    action: "EXPIRE",
    boundary: "2026-09-12T12:00:00.000Z",
    reason: "GRACE_ELAPSED"
  });
});

test("a past-due subscription with no grace window is left to the resolver", () => {
  // Entitlements already read as free in this state; inventing a boundary
  // here would produce a non-deterministic event key.
  assert.equal(decideLifecycleAction(row({ status: "PAST_DUE", grace_period_end: null }), now), null);
});

test("an ended trial ends the subscription: it cannot convert without a processor", () => {
  const decision = decideLifecycleAction(
    row({ status: "TRIALING", trial_end: "2026-09-10T12:00:00.000Z", current_period_end: "2026-10-13T12:00:00.000Z" }),
    now
  );
  assert.deepEqual(decision, {
    action: "EXPIRE",
    boundary: "2026-09-10T12:00:00.000Z",
    reason: "TRIAL_ENDED"
  });
});

test("a running trial is left alone", () => {
  const running = row({ status: "TRIALING", trial_end: "2026-09-27T12:00:00.000Z", current_period_end: "2026-10-13T12:00:00.000Z" });
  assert.equal(decideLifecycleAction(running, now), null);
});

test("a scheduled cancellation whose period elapsed goes through RENEW, which ends it", () => {
  const decision = decideLifecycleAction(row({ status: "CANCELED", cancel_at_period_end: true }), now);
  assert.equal(decision?.action, "RENEW", "one call covers renewal and end-of-cancellation");
  assert.equal(decision?.reason, "PERIOD_ELAPSED");
});

test("the event key derives from the boundary, so a replayed sweep converges", () => {
  const subject = row();
  const first = decideLifecycleAction(subject, now);
  const later = decideLifecycleAction(subject, new Date("2026-09-13T12:05:00.000Z"));
  assert.equal(first?.boundary, later?.boundary, "the key does not drift with the sweep's clock");
});

const monitor = (id: string, status: string, day: number) => ({
  id,
  status,
  created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`
});

test("monitor entitlement: the newest running monitors over the limit pause first", () => {
  const decision = decideMonitorEntitlement(
    [monitor("1", "ACTIVE", 1), monitor("2", "DEGRADED", 2), monitor("3", "ACTIVE", 3)],
    1
  );
  assert.deepEqual(decision, { pause: ["2", "3"], resume: [] });
});

test("monitor entitlement: headroom resumes the oldest entitlement-paused monitors first", () => {
  const decision = decideMonitorEntitlement(
    [monitor("1", "ACTIVE", 1), monitor("4", "ENTITLEMENT_PAUSED", 4), monitor("2", "ENTITLEMENT_PAUSED", 2), monitor("3", "ENTITLEMENT_PAUSED", 3)],
    3
  );
  assert.deepEqual(decision, { pause: [], resume: ["2", "3"] });
});

test("monitor entitlement: a monitor its owner paused is never paused or resumed by the plan", () => {
  assert.deepEqual(decideMonitorEntitlement([monitor("1", "PAUSED", 1), monitor("2", "ACTIVE", 2)], 0), { pause: ["2"], resume: [] });
  assert.deepEqual(decideMonitorEntitlement([monitor("1", "PAUSED", 1), monitor("2", "ENTITLEMENT_PAUSED", 2)], 5), { pause: [], resume: ["2"] });
});

test("monitor entitlement: an identity at its limit is left alone", () => {
  assert.deepEqual(decideMonitorEntitlement([monitor("1", "ACTIVE", 1), monitor("2", "ENTITLEMENT_PAUSED", 2)], 1), { pause: [], resume: [] });
});

test("monitor entitlement: the decision does not depend on input order", () => {
  const monitors = [monitor("1", "ACTIVE", 1), monitor("2", "ACTIVE", 2), monitor("3", "ACTIVE", 3), monitor("4", "ACTIVE", 4)];
  const reversed = [...monitors].reverse();
  assert.deepEqual(decideMonitorEntitlement(monitors, 2), decideMonitorEntitlement(reversed, 2));
});
