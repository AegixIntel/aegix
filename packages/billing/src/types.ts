/**
 * D11 billing / entitlements — shared vocabulary.
 *
 * architecture.md §69 requires the billing layer to stay isolated: this
 * package is pure and deterministic. It owns the plan catalog, entitlement
 * resolution, the subscription state machine, usage-dimension metering and
 * invoice arithmetic. It performs no I/O, reads no environment, and knows
 * nothing about PostgreSQL, Fastify or any payment provider — persistence
 * lives in @aegix/database and the HTTP surface in apps/api.
 */

/** Bumped when entitlement resolution or invoice arithmetic changes. */
export const BILLING_ENGINE_VERSION = "billing-v1.0.0";
/** Bumped when the shipped plan catalog changes shape, price or limits. */
export const PLAN_CATALOG_VERSION = "billing-catalog-v1.0.0";

export type PlanCode = "free" | "pro" | "team";

export const PLAN_CODES: readonly PlanCode[] = ["free", "pro", "team"] as const;

/** The plan every identity falls back to: no subscription, no payment. */
export const DEFAULT_PLAN_CODE: PlanCode = "free";

export function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

export type BillingInterval = "NONE" | "MONTH" | "YEAR";

/**
 * Entitlement keys are the plan-controlled limits. Each one replaces a
 * previously hard-coded config read at an existing enforcement point, so the
 * free plan's values are the config values and nothing changes for a user
 * without a subscription (see `buildPlanCatalog`).
 *
 * `*.daily`  — resets at the UTC day boundary, hard cap.
 * `*.active` — a concurrent level, checked before creating a resource.
 *
 * Two limits are deliberately NOT entitlements:
 *
 * Historical analysis depth is listed as a usage dimension in
 * architecture.md §69, but a completed analysis is shared public blockchain
 * data — one report per wallet serves every caller (D3-C §24). Making depth
 * depend on the requester's plan would make a cached report depend on who
 * paid for it, so depth stays a single engine-wide bound
 * (ANALYSIS_MAX_HISTORY_DAYS).
 *
 * Per-minute request rate is an infrastructure protection sized to what the
 * deployment can absorb in a burst (§81), not something a plan buys. The
 * plan-based part of §82 is the daily quota, which is an entitlement.
 */
export type EntitlementKey =
  | "analysis.daily"
  | "compare.daily"
  | "ask.daily"
  | "markets.daily"
  | "monitors.active"
  | "apiKeys.active"
  | "webhooks.active"
  | "api.daily";

export const ENTITLEMENT_KEYS: readonly EntitlementKey[] = [
  "analysis.daily",
  "compare.daily",
  "ask.daily",
  "markets.daily",
  "monitors.active",
  "apiKeys.active",
  "webhooks.active",
  "api.daily"
] as const;

export function isEntitlementKey(value: string): value is EntitlementKey {
  return (ENTITLEMENT_KEYS as readonly string[]).includes(value);
}

export type Entitlements = Readonly<Record<EntitlementKey, number>>;

/**
 * Metered usage dimensions, architecture.md §69. `MONITORED_WALLETS` is a
 * level rather than a counter — it reports the active monitor count at the
 * time of reading, not an accumulation over the period.
 *
 * Attack analysis is deliberately absent: "Attack My Wallet" is rendered
 * from the same completed analysis record as Wallet X-Ray and creates no
 * additional chain work, so it is not a separately metered dimension.
 */
export type UsageDimension =
  | "WALLET_ANALYSIS"
  | "COMPARISON"
  | "WALLET_CONTEXT"
  | "ASK_AEGIX"
  | "MARKETS"
  | "API_CALLS"
  | "MONITORED_WALLETS";

export const USAGE_DIMENSIONS: readonly UsageDimension[] = [
  "WALLET_ANALYSIS",
  "COMPARISON",
  "WALLET_CONTEXT",
  "ASK_AEGIX",
  "MARKETS",
  "API_CALLS",
  "MONITORED_WALLETS"
] as const;

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  /** Ordering only; a higher tier is never a downgrade of any entitlement. */
  tier: number;
  priceCents: number;
  currency: string;
  interval: BillingInterval;
  entitlements: Entitlements;
  /**
   * Per-unit overage price for dimensions the plan meters softly. The v1
   * catalog ships empty: every dimension is a hard cap, so no invoice can
   * carry an overage line. The arithmetic exists so pricing can be tuned
   * without another schema change (architecture.md §82).
   */
  overageCents: Readonly<Partial<Record<UsageDimension, number>>>;
  status: "ACTIVE" | "RETIRED";
  catalogVersion: string;
}

export type SubscriptionStatus =
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "EXPIRED";

/**
 * A subscription as the entitlement resolver sees it. `CANCELED` means
 * cancellation was scheduled and the paid period is still running;
 * `EXPIRED` means the period has ended and the identity is back on free.
 */
export interface SubscriptionState {
  planCode: PlanCode;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  /**
   * End of the PAST_DUE grace window. Entitlements hold until this instant,
   * then degrade to the free baseline. Never null while PAST_DUE.
   */
  gracePeriodEnd: string | null;
  trialEnd: string | null;
}

export type BillingAction =
  | "SUBSCRIBE"
  | "CHANGE_PLAN"
  | "RENEW"
  | "CANCEL"
  | "RESUME"
  | "CANCEL_IMMEDIATELY"
  | "PAYMENT_FAILED"
  | "PAYMENT_RECOVERED"
  | "EXPIRE";

export type BillingEventType =
  | "SUBSCRIPTION_CREATED"
  | "PLAN_CHANGED"
  | "SUBSCRIPTION_RENEWED"
  | "CANCELLATION_SCHEDULED"
  | "CANCELLATION_REVOKED"
  | "SUBSCRIPTION_CANCELED"
  | "PAYMENT_FAILED"
  | "PAYMENT_RECOVERED"
  | "SUBSCRIPTION_EXPIRED";

export interface MeteredUsage {
  dimension: UsageDimension;
  units: number;
}

export interface BillingPeriod {
  start: string;
  end: string;
}

export type InvoiceLineKind = "SUBSCRIPTION" | "OVERAGE";

export interface InvoiceLine {
  kind: InvoiceLineKind;
  description: string;
  dimension: UsageDimension | null;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

export interface InvoiceDraft {
  planCode: PlanCode;
  currency: string;
  periodStart: string;
  periodEnd: string;
  lines: InvoiceLine[];
  subtotalCents: number;
  totalCents: number;
  engineVersion: string;
}

export type BillingErrorCode =
  | "UNKNOWN_PLAN"
  | "RETIRED_PLAN"
  | "INVALID_TRANSITION"
  | "PAYMENT_PROVIDER_REQUIRED"
  | "NOT_SUPPORTED";

export class BillingError extends Error {
  constructor(readonly code: BillingErrorCode, message: string) {
    super(message);
    this.name = "BillingError";
  }
}
