/**
 * Usage metering, architecture.md §69.
 *
 * Metering does not count anything itself — the counting already happens in
 * `usage_records` (D3-F) and `developer_usage_events` (D6-D). This module is
 * the mapping layer: it turns those storage-level usage types into the
 * billing dimensions the product actually sells, and reconciles each
 * dimension against the plan entitlement that bounds it.
 *
 * Keeping the mapping here means a new metered surface is one table entry,
 * not a new counter, and the audit trail stays a single source of truth.
 */

import { daysInPeriod } from "./period.js";
import type { BillingPeriod, Entitlements, EntitlementKey, MeteredUsage, UsageDimension } from "./types.js";

/**
 * `usage_records.usage_type` → billing dimension. `cache_hit` is absent by
 * design: a cache hit consumes no quota (D3-C §24) and must never appear on
 * an invoice as though work had been done.
 */
const USAGE_TYPE_TO_DIMENSION: Readonly<Record<string, UsageDimension>> = {
  expensive_analysis: "WALLET_ANALYSIS",
  comparison: "COMPARISON",
  wallet_context: "WALLET_CONTEXT",
  ask_aegix: "ASK_AEGIX",
  ask_markets: "ASK_AEGIX",
  markets: "MARKETS"
};

export function dimensionForUsageType(usageType: string): UsageDimension | null {
  return USAGE_TYPE_TO_DIMENSION[usageType] ?? null;
}

/** The storage-level usage types that roll up into a dimension. */
export function usageTypesForDimension(dimension: UsageDimension): string[] {
  return Object.entries(USAGE_TYPE_TO_DIMENSION)
    .filter(([, value]) => value === dimension)
    .map(([key]) => key);
}

/**
 * The entitlement that bounds each dimension. `WALLET_CONTEXT` has none: it
 * is a read over already-persisted analysis results and is bounded by a
 * per-minute rate limit rather than a daily quota (D8 §10). It is still
 * metered, because it is still usage.
 */
const DIMENSION_ENTITLEMENT: Readonly<Partial<Record<UsageDimension, EntitlementKey>>> = {
  WALLET_ANALYSIS: "analysis.daily",
  COMPARISON: "compare.daily",
  ASK_AEGIX: "ask.daily",
  MARKETS: "markets.daily",
  API_CALLS: "api.daily",
  MONITORED_WALLETS: "monitors.active"
};

export function entitlementForDimension(dimension: UsageDimension): EntitlementKey | null {
  return DIMENSION_ENTITLEMENT[dimension] ?? null;
}

/** Dimensions expressed as a concurrent level rather than an accumulation. */
export function isLevelDimension(dimension: UsageDimension): boolean {
  return dimension === "MONITORED_WALLETS";
}

export interface DimensionSummary {
  dimension: UsageDimension;
  /** Units consumed in the period, or the current level for a level dimension. */
  units: number;
  entitlementKey: EntitlementKey | null;
  /** The per-day cap, or the concurrent cap for a level dimension. */
  limit: number | null;
  /**
   * What the plan includes across the whole period: `limit * days` for daily
   * quotas, `limit` for level dimensions, null when unbounded by a plan.
   */
  includedUnits: number | null;
  /** Units past `includedUnits`; always 0 while every dimension is hard-capped. */
  overageUnits: number;
}

export interface UsageSummary {
  period: BillingPeriod;
  days: number;
  dimensions: DimensionSummary[];
}

/**
 * Reconciles metered usage against the resolved entitlements for a period.
 * Dimensions with no usage are still reported, so a caller always sees the
 * full sellable surface rather than only what happened to be touched.
 */
export function summarizeUsage(
  usage: readonly MeteredUsage[],
  entitlements: Entitlements,
  period: BillingPeriod,
  dimensions: readonly UsageDimension[]
): UsageSummary {
  const days = daysInPeriod(period);
  const counted = new Map<UsageDimension, number>();
  for (const record of usage) {
    counted.set(record.dimension, (counted.get(record.dimension) ?? 0) + record.units);
  }

  return {
    period,
    days,
    dimensions: dimensions.map((dimension) => {
      const units = counted.get(dimension) ?? 0;
      const entitlementKey = entitlementForDimension(dimension);
      const limit = entitlementKey ? entitlements[entitlementKey] : null;
      const includedUnits = limit === null ? null : isLevelDimension(dimension) ? limit : limit * days;
      return {
        dimension,
        units,
        entitlementKey,
        limit,
        includedUnits,
        overageUnits: includedUnits === null ? 0 : Math.max(0, units - includedUnits)
      };
    })
  };
}
