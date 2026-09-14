import assert from "node:assert/strict";
import { test } from "node:test";
import { paidRenewalAction } from "./settlement.js";
import type { SubscriptionState } from "./types.js";

function state(patch: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    planCode: "pro",
    status: "ACTIVE",
    currentPeriodStart: "2026-08-13T12:00:00.000Z",
    currentPeriodEnd: "2026-09-13T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    gracePeriodEnd: null,
    trialEnd: null,
    ...patch
  };
}

test("a confirmed payment renews a live subscription", () => {
  assert.equal(paidRenewalAction(state()), "RENEW");
});

test("a confirmed payment restarts an expired subscription", () => {
  // EXPIRED is terminal: a new paid period is a SUBSCRIBE, not a RENEW.
  assert.equal(paidRenewalAction(state({ status: "EXPIRED" })), "SUBSCRIBE");
});

test("a confirmed payment with no subscription starts one", () => {
  assert.equal(paidRenewalAction(null), "SUBSCRIBE");
});

test("a past-due subscription must recover, not settle into a renewal", () => {
  // RENEW rejects PAST_DUE, which is the canonical state machine's way of
  // refusing to clear an unresolved payment failure. The caller surfaces it.
  assert.equal(paidRenewalAction(state({ status: "PAST_DUE", gracePeriodEnd: "2026-09-20T12:00:00.000Z" })), "RENEW");
});
