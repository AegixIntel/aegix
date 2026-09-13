/**
 * Processor state → D11 subscription state.
 *
 * A payment processor is the source of truth for a subscription it manages:
 * it decides when a payment failed, recovered, renewed or ended. The provider
 * adapter normalizes what the processor reports into a
 * ProviderSubscriptionSnapshot; this module turns that into the same
 * SubscriptionState and ledger vocabulary the manual state machine produces,
 * so entitlement resolution never learns a processor exists.
 *
 * Three rules make processor callbacks safe to apply:
 *
 *  1. Order. Callbacks arrive at least once and in any order. A snapshot
 *     observed before the newest one already applied is stale and changes
 *     nothing, so an old "active" can never revert a newer "past due".
 *  2. Ownership. A processor subscription the identity is not bound to never
 *     replaces a live one it is bound to.
 *  3. Nothing unpaid grants anything. An INCOMPLETE snapshot is ignored.
 *
 * Pure: the caller loads current state and persists the result atomically.
 */

import type { BillingEventDraft } from "./lifecycle.js";
import { DEFAULT_PLAN_CODE, type BillingEventType, type PlanCode, type SubscriptionState } from "./types.js";

/** Processor-neutral subscription states. NONE is the absence of one. */
export type NormalizedSubscriptionStatus =
  | "NONE"
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "INCOMPLETE"
  | "EXPIRED";

export interface ProviderSubscriptionSnapshot {
  provider: string;
  subscriptionRef: string;
  customerRef: string | null;
  planCode: PlanCode;
  /**
   * CANCELED means cancellation is scheduled and the paid period still runs,
   * exactly as in the manual state machine; EXPIRED means it has ended.
   */
  status: NormalizedSubscriptionStatus;
  periodStart: string;
  periodEnd: string;
  trialEnd: string | null;
  /** When the processor observed this state. Orders snapshots. */
  observedAt: string;
}

/** The processor binding stored next to the current subscription. */
export interface ProviderBinding {
  provider: string;
  subscriptionRef: string | null;
  observedAt: string | null;
}

export type ProviderSyncIgnoredReason = "INCOMPLETE" | "NOT_BOUND" | "SUPERSEDED";

export type ProviderSyncDecision =
  | { kind: "apply"; subscription: SubscriptionState; event: BillingEventDraft }
  | { kind: "unchanged" }
  | { kind: "stale" }
  | { kind: "ignored"; reason: ProviderSyncIgnoredReason };

export interface ReconcileInput {
  current: SubscriptionState | null;
  binding: ProviderBinding | null;
  snapshot: ProviderSubscriptionSnapshot;
  /** PAST_DUE grace window, as for the manual state machine. */
  graceDays: number;
}

const DAY_MS = 86_400_000;

function iso(value: string): string {
  return new Date(value).toISOString();
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

function sameState(a: SubscriptionState, b: SubscriptionState): boolean {
  return (
    a.planCode === b.planCode &&
    a.status === b.status &&
    a.cancelAtPeriodEnd === b.cancelAtPeriodEnd &&
    sameInstant(a.currentPeriodStart, b.currentPeriodStart) &&
    sameInstant(a.currentPeriodEnd, b.currentPeriodEnd) &&
    sameInstant(a.gracePeriodEnd, b.gracePeriodEnd) &&
    sameInstant(a.trialEnd, b.trialEnd)
  );
}

type LiveSnapshotStatus = Exclude<NormalizedSubscriptionStatus, "NONE" | "INCOMPLETE">;

function targetState(
  status: LiveSnapshotStatus,
  snapshot: ProviderSubscriptionSnapshot,
  current: SubscriptionState | null,
  bound: boolean,
  graceDays: number
): SubscriptionState {
  const base = {
    planCode: snapshot.planCode,
    currentPeriodStart: iso(snapshot.periodStart),
    currentPeriodEnd: iso(snapshot.periodEnd)
  };
  switch (status) {
    case "TRIALING":
      return { ...base, status, cancelAtPeriodEnd: false, gracePeriodEnd: null, trialEnd: iso(snapshot.trialEnd ?? snapshot.periodEnd) };
    case "ACTIVE":
      return { ...base, status, cancelAtPeriodEnd: false, gracePeriodEnd: null, trialEnd: null };
    case "CANCELED":
      return { ...base, status, cancelAtPeriodEnd: true, gracePeriodEnd: null, trialEnd: null };
    case "PAST_DUE": {
      // Anchored to the first failure the processor reported: repeated
      // failures never extend the window, as in the manual state machine.
      const graceEnd =
        bound && current?.status === "PAST_DUE" && current.gracePeriodEnd
          ? current.gracePeriodEnd
          : new Date(Date.parse(snapshot.observedAt) + graceDays * DAY_MS).toISOString();
      return { ...base, status, cancelAtPeriodEnd: false, gracePeriodEnd: graceEnd, trialEnd: null };
    }
    case "EXPIRED":
      return {
        ...base,
        // An ended subscription keeps the period it was last in.
        currentPeriodStart: bound && current ? current.currentPeriodStart : base.currentPeriodStart,
        status,
        cancelAtPeriodEnd: bound && current ? current.cancelAtPeriodEnd : false,
        gracePeriodEnd: null,
        trialEnd: null
      };
  }
}

function eventTypeFor(current: SubscriptionState | null, next: SubscriptionState, bound: boolean): BillingEventType {
  if (!bound || current === null || current.status === "EXPIRED") {
    return next.status === "EXPIRED" ? "SUBSCRIPTION_UPDATED" : "SUBSCRIPTION_CREATED";
  }
  const from = current.status;
  if (next.status === "EXPIRED") return from === "CANCELED" ? "SUBSCRIPTION_EXPIRED" : "SUBSCRIPTION_CANCELED";
  if (next.status === "PAST_DUE" && from !== "PAST_DUE") return "PAYMENT_FAILED";
  if (from === "PAST_DUE" && next.status !== "PAST_DUE") {
    return next.status === "CANCELED" ? "CANCELLATION_SCHEDULED" : "PAYMENT_RECOVERED";
  }
  if (next.status === "CANCELED" && from !== "CANCELED") return "CANCELLATION_SCHEDULED";
  if (from === "CANCELED" && next.status !== "CANCELED") return "CANCELLATION_REVOKED";
  if (next.planCode !== current.planCode) return "PLAN_CHANGED";
  if (Date.parse(next.currentPeriodEnd) > Date.parse(current.currentPeriodEnd)) return "SUBSCRIPTION_RENEWED";
  return "SUBSCRIPTION_UPDATED";
}

export function reconcileProviderSubscription(input: ReconcileInput): ProviderSyncDecision {
  const { current, binding, snapshot } = input;
  const status = snapshot.status;
  if (status === "NONE" || status === "INCOMPLETE") return { kind: "ignored", reason: "INCOMPLETE" };

  const bound =
    binding !== null && binding.provider === snapshot.provider && binding.subscriptionRef === snapshot.subscriptionRef;
  const live = current !== null && current.status !== "EXPIRED";

  if (!bound) {
    // An ended subscription this identity is not bound to has nothing to give it.
    if (status === "EXPIRED") return { kind: "ignored", reason: "NOT_BOUND" };
    // A second processor subscription never displaces a live one. An operator
    // grant does not block a subscription the customer actually paid for.
    if (live && binding !== null && binding.provider !== "manual") return { kind: "ignored", reason: "SUPERSEDED" };
  } else if (binding?.observedAt && Date.parse(snapshot.observedAt) < Date.parse(binding.observedAt)) {
    return { kind: "stale" };
  }

  const next = targetState(status, snapshot, current, bound, input.graceDays);
  if (bound && current && sameState(current, next)) return { kind: "unchanged" };

  const event: BillingEventDraft = {
    type: eventTypeFor(current, next, bound),
    fromStatus: current?.status ?? "NONE",
    toStatus: next.status,
    fromPlan: current?.planCode ?? DEFAULT_PLAN_CODE,
    toPlan: next.planCode,
    occurredAt: iso(snapshot.observedAt),
    detail: {
      provider: snapshot.provider,
      subscriptionRef: snapshot.subscriptionRef,
      ...(next.status === "PAST_DUE" ? { gracePeriodEnd: next.gracePeriodEnd } : {})
    }
  };
  return { kind: "apply", subscription: next, event };
}
