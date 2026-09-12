import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBillingAction, profilePlanLabel, type BillingStore, type BillingStoreSaveInput } from "./apply.js";
import { buildPlanCatalog, type EntitlementBaseline } from "./catalog.js";
import { BillingError, type SubscriptionState } from "./types.js";

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

function fakeStore(initial: SubscriptionState | null) {
  const saved: BillingStoreSaveInput[] = [];
  const keys = new Set<string>();
  let state = initial;
  const store: BillingStore = {
    async load() {
      return state;
    },
    async save(input) {
      if (keys.has(input.eventKey)) return false;
      keys.add(input.eventKey);
      saved.push(input);
      state = input.subscription;
      return true;
    }
  };
  return { store, saved, current: () => state };
}

test("a subscribe decides then persists exactly one event", async () => {
  const { store, saved } = fakeStore(null);
  const result = await applyBillingAction(store, catalog, { userId: "u1", action: "SUBSCRIBE", planCode: "pro", now });
  assert.equal(result.applied, true);
  assert.equal(result.subscription.planCode, "pro");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.event.type, "SUBSCRIPTION_CREATED");
  assert.equal(saved[0]?.profilePlan, "pro");
});

test("actions without a target plan act on the plan already held", async () => {
  const { store } = fakeStore({
    planCode: "team",
    status: "ACTIVE",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    gracePeriodEnd: null,
    trialEnd: null
  });
  const result = await applyBillingAction(store, catalog, { userId: "u1", action: "CANCEL", now });
  assert.equal(result.subscription.planCode, "team");
  assert.equal(result.event.type, "CANCELLATION_SCHEDULED");
});

test("an unknown plan is refused before anything is written", async () => {
  const { store, saved } = fakeStore(null);
  await assert.rejects(
    () => applyBillingAction(store, catalog, { userId: "u1", action: "SUBSCRIBE", planCode: "enterprise" as never, now }),
    (error: unknown) => error instanceof BillingError && error.code === "UNKNOWN_PLAN"
  );
  assert.equal(saved.length, 0);
});

test("an invalid transition is refused before anything is written", async () => {
  const { store, saved } = fakeStore(null);
  await assert.rejects(
    () => applyBillingAction(store, catalog, { userId: "u1", action: "CANCEL", now }),
    (error: unknown) => error instanceof BillingError && error.code === "INVALID_TRANSITION"
  );
  assert.equal(saved.length, 0);
});

test("a deterministic event key makes a replayed machine transition a no-op", async () => {
  const { store, saved } = fakeStore({
    planCode: "pro",
    status: "ACTIVE",
    currentPeriodStart: "2026-08-13T12:00:00.000Z",
    currentPeriodEnd: "2026-09-13T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    gracePeriodEnd: null,
    trialEnd: null
  });
  const key = "u1:RENEW:2026-09-13T12:00:00.000Z";
  const first = await applyBillingAction(store, catalog, { userId: "u1", action: "RENEW", now, eventKey: key });
  assert.equal(first.applied, true);
  assert.equal(first.subscription.currentPeriodEnd, "2026-10-13T12:00:00.000Z");

  // The sweep runs again against the already-renewed row: a second RENEW is
  // computed but the ledger absorbs it, so the period cannot advance twice.
  const second = await applyBillingAction(store, catalog, { userId: "u1", action: "RENEW", now, eventKey: key });
  assert.equal(second.applied, false);
  assert.equal(saved.length, 1);
});

test("user-initiated actions get a distinct key per call", async () => {
  const { store } = fakeStore(null);
  const first = await applyBillingAction(store, catalog, { userId: "u1", action: "SUBSCRIBE", planCode: "pro", now });
  assert.equal(first.applied, true);
  const later = new Date("2026-09-14T12:00:00.000Z");
  const cancel = await applyBillingAction(store, catalog, { userId: "u1", action: "CANCEL", now: later });
  assert.equal(cancel.applied, true);
});

test("profilePlanLabel reports free once a subscription has ended", () => {
  const ended: SubscriptionState = {
    planCode: "pro",
    status: "EXPIRED",
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    cancelAtPeriodEnd: true,
    gracePeriodEnd: null,
    trialEnd: null
  };
  assert.equal(profilePlanLabel(ended), "free");
  assert.equal(profilePlanLabel({ ...ended, status: "PAST_DUE" }), "pro");
});
