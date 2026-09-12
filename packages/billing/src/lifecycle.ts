/**
 * Subscription lifecycle, architecture.md §69.
 *
 * A pure state machine: every call takes the current state and an action and
 * returns the next state plus exactly one billing event. Nothing here writes
 * anything — the caller persists the returned state and appends the returned
 * event to the append-only `billing_events` ledger in one transaction, so
 * state and audit trail can never drift apart.
 *
 *   (none) --SUBSCRIBE--> TRIALING --(RENEW)--> ACTIVE
 *                             |                   |
 *                      PAYMENT_FAILED      PAYMENT_FAILED
 *                             v                   v
 *                          PAST_DUE --PAYMENT_RECOVERED--> ACTIVE
 *                             |
 *                        (grace ends)
 *                             v
 *                          EXPIRED
 *
 *   ACTIVE --CANCEL--> CANCELED --RENEW/EXPIRE--> EXPIRED
 *                          |
 *                      --RESUME--> ACTIVE
 */

import { addInterval, periodFrom } from "./period.js";
import {
  BillingError,
  DEFAULT_PLAN_CODE,
  type BillingAction,
  type BillingEventType,
  type PlanDefinition,
  type SubscriptionState,
  type SubscriptionStatus
} from "./types.js";

export interface BillingEventDraft {
  type: BillingEventType;
  fromStatus: SubscriptionStatus | "NONE";
  toStatus: SubscriptionStatus;
  fromPlan: string;
  toPlan: string;
  occurredAt: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface TransitionInput {
  subscription: SubscriptionState | null;
  action: BillingAction;
  /** Target plan for SUBSCRIBE/CHANGE_PLAN, current plan for every other action. */
  plan: PlanDefinition;
  now: Date;
  /** Trial length for a first SUBSCRIBE; 0 disables the trial. */
  trialDays?: number;
  /** PAST_DUE grace window before entitlements degrade to free. */
  graceDays?: number;
}

export interface TransitionResult {
  subscription: SubscriptionState;
  event: BillingEventDraft;
}

const LIVE_STATUSES: readonly SubscriptionStatus[] = ["TRIALING", "ACTIVE", "PAST_DUE"];

function invalid(action: BillingAction, from: SubscriptionStatus | "NONE"): never {
  throw new BillingError("INVALID_TRANSITION", `Cannot ${action} a subscription in state ${from}`);
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function transition(input: TransitionInput): TransitionResult {
  const { subscription, action, plan, now } = input;
  const from: SubscriptionStatus | "NONE" = subscription?.status ?? "NONE";
  const fromPlan = subscription?.planCode ?? DEFAULT_PLAN_CODE;
  const occurredAt = now.toISOString();
  const graceDays = input.graceDays ?? 0;
  const trialDays = input.trialDays ?? 0;

  const emit = (
    next: SubscriptionState,
    type: BillingEventType,
    detail: BillingEventDraft["detail"] = {}
  ): TransitionResult => ({
    subscription: next,
    event: { type, fromStatus: from, toStatus: next.status, fromPlan, toPlan: next.planCode, occurredAt, detail }
  });

  if ((action === "SUBSCRIBE" || action === "CHANGE_PLAN") && plan.status !== "ACTIVE") {
    throw new BillingError("RETIRED_PLAN", `Plan ${plan.code} is retired and cannot be subscribed to`);
  }

  if (action === "SUBSCRIBE") {
    // Only a fresh or fully-ended subscription may be (re)started; a live
    // subscription must go through CHANGE_PLAN.
    if (from !== "NONE" && from !== "EXPIRED") invalid(action, from);
    if (plan.code === DEFAULT_PLAN_CODE) {
      throw new BillingError("INVALID_TRANSITION", "The free plan is the absence of a subscription, not a subscription");
    }
    const period = periodFrom(now, plan.interval);
    const trialing = trialDays > 0;
    return emit(
      {
        planCode: plan.code,
        status: trialing ? "TRIALING" : "ACTIVE",
        currentPeriodStart: period.start,
        currentPeriodEnd: period.end,
        cancelAtPeriodEnd: false,
        gracePeriodEnd: null,
        trialEnd: trialing ? addDays(now, trialDays).toISOString() : null
      },
      "SUBSCRIPTION_CREATED",
      { trialDays, priceCents: plan.priceCents }
    );
  }

  if (!subscription) invalid(action, from);

  switch (action) {
    case "CHANGE_PLAN": {
      if (!LIVE_STATUSES.includes(subscription.status)) invalid(action, from);
      if (plan.code === DEFAULT_PLAN_CODE) {
        throw new BillingError("INVALID_TRANSITION", "Moving to the free plan is a cancellation, not a plan change");
      }
      if (plan.code === fromPlan) invalid(action, from);
      // The period is preserved: a plan change mid-period takes effect now
      // and settles on the next invoice, rather than silently restarting the
      // billing period (which would re-charge the customer for days already
      // paid for).
      return emit(
        { ...subscription, planCode: plan.code, cancelAtPeriodEnd: false },
        "PLAN_CHANGED",
        { priceCents: plan.priceCents }
      );
    }

    case "RENEW": {
      if (subscription.status === "EXPIRED") invalid(action, from);
      // A past-due subscription must recover before it can renew. Renewing
      // it would advance the period and set it ACTIVE again, silently
      // clearing a payment failure nobody resolved.
      if (subscription.status === "PAST_DUE") invalid(action, from);
      // Renewing a subscription already scheduled for cancellation is the
      // moment it actually ends. Handling it here keeps the periodic job
      // from having to branch, and from forgetting to.
      if (subscription.cancelAtPeriodEnd || subscription.status === "CANCELED") {
        return emit(
          { ...subscription, status: "EXPIRED", gracePeriodEnd: null, trialEnd: null },
          "SUBSCRIPTION_EXPIRED",
          { reason: "CANCELLED_AT_PERIOD_END" }
        );
      }
      const next = periodFrom(new Date(subscription.currentPeriodEnd), plan.interval);
      return emit(
        {
          ...subscription,
          status: "ACTIVE",
          currentPeriodStart: next.start,
          currentPeriodEnd: next.end,
          gracePeriodEnd: null,
          trialEnd: null
        },
        "SUBSCRIPTION_RENEWED",
        { priceCents: plan.priceCents }
      );
    }

    case "CANCEL": {
      if (!LIVE_STATUSES.includes(subscription.status)) invalid(action, from);
      return emit(
        { ...subscription, status: "CANCELED", cancelAtPeriodEnd: true },
        "CANCELLATION_SCHEDULED",
        { effectiveAt: subscription.currentPeriodEnd }
      );
    }

    case "RESUME": {
      if (subscription.status !== "CANCELED") invalid(action, from);
      if (Date.parse(subscription.currentPeriodEnd) <= now.getTime()) {
        throw new BillingError("INVALID_TRANSITION", "The cancelled period has already ended; subscribe again instead");
      }
      return emit({ ...subscription, status: "ACTIVE", cancelAtPeriodEnd: false }, "CANCELLATION_REVOKED", {});
    }

    case "CANCEL_IMMEDIATELY": {
      if (subscription.status === "EXPIRED") invalid(action, from);
      return emit(
        {
          ...subscription,
          status: "EXPIRED",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: occurredAt,
          gracePeriodEnd: null,
          trialEnd: null
        },
        "SUBSCRIPTION_CANCELED",
        { immediate: true }
      );
    }

    case "PAYMENT_FAILED": {
      if (!LIVE_STATUSES.includes(subscription.status)) invalid(action, from);
      // Repeated failures never extend the grace window: it is anchored to
      // the first failure, so a retry storm cannot buy free paid service.
      const graceEnd = subscription.status === "PAST_DUE" && subscription.gracePeriodEnd
        ? subscription.gracePeriodEnd
        : addDays(now, graceDays).toISOString();
      return emit(
        { ...subscription, status: "PAST_DUE", gracePeriodEnd: graceEnd, trialEnd: null },
        "PAYMENT_FAILED",
        { gracePeriodEnd: graceEnd }
      );
    }

    case "PAYMENT_RECOVERED": {
      if (subscription.status !== "PAST_DUE") invalid(action, from);
      return emit({ ...subscription, status: "ACTIVE", gracePeriodEnd: null }, "PAYMENT_RECOVERED", {});
    }

    case "EXPIRE": {
      if (subscription.status === "EXPIRED") invalid(action, from);
      return emit(
        { ...subscription, status: "EXPIRED", gracePeriodEnd: null, trialEnd: null },
        "SUBSCRIPTION_EXPIRED",
        { reason: "EXPIRED" }
      );
    }

    default:
      return invalid(action, from);
  }
}

/**
 * The instant the periodic lifecycle job should next act on this
 * subscription: whichever bound arrives first.
 */
export function nextLifecycleDeadline(subscription: SubscriptionState): string {
  const candidates = [subscription.currentPeriodEnd];
  if (subscription.status === "PAST_DUE" && subscription.gracePeriodEnd) candidates.push(subscription.gracePeriodEnd);
  if (subscription.status === "TRIALING" && subscription.trialEnd) candidates.push(subscription.trialEnd);
  return candidates.reduce((earliest, candidate) => (Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest));
}

export { addInterval };
