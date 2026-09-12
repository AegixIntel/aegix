/**
 * Entitlement resolution: subscription state → the limits actually enforced.
 *
 * Two rules make this safe to wire into live enforcement points:
 *
 *  1. No subscription resolves to the free plan, and the free plan is the
 *     deployment baseline — so enabling D11 changes nothing for existing
 *     identities.
 *  2. Entitlements never resolve below the free baseline. A failed payment,
 *     an expired trial or a stale row degrades a customer to free; it can
 *     never leave them worse off than someone who never paid.
 */

import { calendarMonth } from "./period.js";
import {
  BILLING_ENGINE_VERSION,
  DEFAULT_PLAN_CODE,
  ENTITLEMENT_KEYS,
  type BillingPeriod,
  type Entitlements,
  type EntitlementKey,
  type PlanCode,
  type PlanDefinition,
  type SubscriptionState,
  type SubscriptionStatus
} from "./types.js";

export interface ResolvedEntitlements {
  /** The plan whose entitlements are actually enforced right now. */
  planCode: PlanCode;
  /** The plan the identity holds a subscription for, free when none. */
  subscribedPlanCode: PlanCode;
  status: SubscriptionStatus | "NONE";
  /** True when the subscribed plan is not the enforced plan. */
  degraded: boolean;
  entitlements: Entitlements;
  period: BillingPeriod;
  engineVersion: string;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/**
 * The plan a subscription currently entitles the identity to. Grace windows
 * are honoured; anything past them falls back to the default plan.
 */
export function effectivePlanCode(subscription: SubscriptionState | null, now: Date): PlanCode {
  if (!subscription) return DEFAULT_PLAN_CODE;
  const at = now.getTime();
  const periodEnd = ms(subscription.currentPeriodEnd);

  switch (subscription.status) {
    case "EXPIRED":
      return DEFAULT_PLAN_CODE;
    case "CANCELED":
      // Cancellation scheduled: the paid period is honoured to its last
      // instant, then the identity returns to free.
      return periodEnd !== null && at < periodEnd ? subscription.planCode : DEFAULT_PLAN_CODE;
    case "PAST_DUE": {
      const grace = ms(subscription.gracePeriodEnd);
      return grace !== null && at < grace ? subscription.planCode : DEFAULT_PLAN_CODE;
    }
    case "TRIALING": {
      const trialEnd = ms(subscription.trialEnd);
      return trialEnd !== null && at >= trialEnd ? DEFAULT_PLAN_CODE : subscription.planCode;
    }
    case "ACTIVE":
      // A late renewal is an operational failure on our side, never a
      // customer-visible downgrade: ACTIVE holds until something transitions
      // it to PAST_DUE, CANCELED or EXPIRED.
      return subscription.planCode;
    default:
      return DEFAULT_PLAN_CODE;
  }
}

/** Elementwise floor: no resolution ever drops below the free baseline. */
export function atLeast(entitlements: Entitlements, floor: Entitlements): Entitlements {
  const out = {} as Record<EntitlementKey, number>;
  for (const key of ENTITLEMENT_KEYS) out[key] = Math.max(entitlements[key], floor[key]);
  return out;
}

export function resolveEntitlements(
  catalog: readonly PlanDefinition[],
  subscription: SubscriptionState | null,
  now: Date
): ResolvedEntitlements {
  const free = catalog.find((plan) => plan.code === DEFAULT_PLAN_CODE);
  if (!free) throw new Error("plan catalog is missing the default plan");

  const effective = effectivePlanCode(subscription, now);
  const plan = catalog.find((p) => p.code === effective) ?? free;
  const subscribed = subscription?.planCode ?? DEFAULT_PLAN_CODE;

  return {
    planCode: plan.code,
    subscribedPlanCode: subscribed,
    status: subscription?.status ?? "NONE",
    degraded: subscribed !== plan.code,
    entitlements: atLeast(plan.entitlements, free.entitlements),
    period: subscription
      ? { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd }
      : calendarMonth(now),
    engineVersion: BILLING_ENGINE_VERSION
  };
}

export function entitlementFor(resolved: ResolvedEntitlements, key: EntitlementKey): number {
  return resolved.entitlements[key];
}
