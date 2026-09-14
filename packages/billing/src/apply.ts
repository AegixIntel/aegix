/**
 * Applying a transition: decide, then persist, in that order.
 *
 * The store is a port, not a repository — this package stays free of any
 * database dependency (architecture.md §69, "keep billing isolated"), and
 * both the API and the worker's lifecycle sweep drive the same orchestration
 * rather than each re-implementing it slightly differently.
 */

import { transition, type BillingEventDraft } from "./lifecycle.js";
import { findPlan } from "./catalog.js";
import {
  BillingError,
  DEFAULT_PLAN_CODE,
  type BillingAction,
  type PlanCode,
  type PlanDefinition,
  type SubscriptionState
} from "./types.js";

export interface BillingStoreSaveInput {
  userId: string;
  subscription: SubscriptionState;
  event: BillingEventDraft;
  /** Idempotency anchor for the ledger entry. */
  eventKey: string;
  /** Denormalized plan label for legacy readers of profiles.plan. */
  profilePlan: string;
  /**
   * Which payment provider owns this subscription. Persistence stores this
   * so a transition decided for the manual path cannot relabel a
   * processor-managed row as manual.
   */
  provider: string;
  providerRef: string | null;
}

export interface BillingStore {
  load(userId: string): Promise<SubscriptionState | null>;
  /** Persists state and ledger entry atomically; false when already applied. */
  save(input: BillingStoreSaveInput): Promise<boolean>;
}

export interface ApplyBillingActionInput {
  userId: string;
  action: BillingAction;
  /** Target plan for SUBSCRIBE/CHANGE_PLAN; ignored for every other action. */
  planCode?: PlanCode;
  now: Date;
  trialDays?: number;
  graceDays?: number;
  /**
   * Supply a deterministic key for machine-driven transitions (a renewal
   * sweep, a provider callback) so a retry is absorbed rather than applied
   * twice. User-initiated actions leave it unset: the state machine already
   * rejects a repeated action, with a clearer error than silence.
   */
  eventKey?: string;
  /**
   * The provider that owns the subscription being transitioned. Defaults to
   * `manual`. A caller acting on an existing row passes the row's provider so
   * the write preserves it instead of relabelling the subscription.
   */
  provider?: string;
  providerRef?: string | null;
}

export interface ApplyBillingActionResult {
  subscription: SubscriptionState;
  event: BillingEventDraft;
  /** False when the ledger already held this event and nothing was written. */
  applied: boolean;
}

/** profiles.plan is a label for the plan being paid for, not the ledger. */
export function profilePlanLabel(subscription: SubscriptionState): string {
  return subscription.status === "EXPIRED" ? DEFAULT_PLAN_CODE : subscription.planCode;
}

export async function applyBillingAction(
  store: BillingStore,
  catalog: readonly PlanDefinition[],
  input: ApplyBillingActionInput
): Promise<ApplyBillingActionResult> {
  const current = await store.load(input.userId);

  // SUBSCRIBE and CHANGE_PLAN name their target; everything else acts on the
  // plan the subscription already holds.
  const targetCode = input.planCode ?? current?.planCode ?? DEFAULT_PLAN_CODE;
  const plan = findPlan(catalog, targetCode);
  if (!plan) throw new BillingError("UNKNOWN_PLAN", `Unknown plan: ${targetCode}`);

  const result = transition({
    subscription: current,
    action: input.action,
    plan,
    now: input.now,
    trialDays: input.trialDays,
    graceDays: input.graceDays
  });

  const eventKey = input.eventKey ?? `${input.userId}:${result.event.type}:${result.event.occurredAt}`;
  const applied = await store.save({
    userId: input.userId,
    subscription: result.subscription,
    event: result.event,
    eventKey,
    profilePlan: profilePlanLabel(result.subscription),
    provider: input.provider ?? "manual",
    providerRef: input.providerRef ?? null
  });

  return { subscription: result.subscription, event: result.event, applied };
}
