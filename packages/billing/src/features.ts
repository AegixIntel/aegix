/**
 * D11 feature registry: every product surface an entitlement decision can be
 * asked about, whether or not a plan meters it.
 *
 * Entitlement and quota stay separate questions (architecture.md §82):
 *  - entitlement — does this plan include the feature at all? (`canUseFeature`)
 *  - quota — how much of it? (the numeric `EntitlementKey`, when there is one)
 *
 * Every v1 plan includes every feature: plans differ only in quota. A feature
 * without a quota key is unmetered for the plans that include it.
 */

import { PLAN_CODES, type EntitlementKey, type PlanCode } from "./types.js";

export type FeatureKey =
  | "WALLET_XRAY"
  | "ATTACK_MY_WALLET"
  | "WALLET_CONTEXT"
  | "COMPARE"
  | "MONITOR"
  | "ASK_AEGIX"
  | "MARKETS"
  | "SAVED_ANALYSES"
  | "SAVED_COMPARISONS"
  | "DEVELOPER_API"
  | "API_KEYS"
  | "WEBHOOKS";

export const FEATURE_KEYS: readonly FeatureKey[] = [
  "WALLET_XRAY",
  "ATTACK_MY_WALLET",
  "WALLET_CONTEXT",
  "COMPARE",
  "MONITOR",
  "ASK_AEGIX",
  "MARKETS",
  "SAVED_ANALYSES",
  "SAVED_COMPARISONS",
  "DEVELOPER_API",
  "API_KEYS",
  "WEBHOOKS"
] as const;

export interface FeatureDefinition {
  key: FeatureKey;
  /** The entitlement that bounds usage, or null when the feature is unmetered. */
  quota: EntitlementKey | null;
  /** Plans that include the feature. */
  plans: readonly PlanCode[];
}

function feature(key: FeatureKey, quota: EntitlementKey | null): FeatureDefinition {
  return { key, quota, plans: PLAN_CODES };
}

export const FEATURE_REGISTRY: Readonly<Record<FeatureKey, FeatureDefinition>> = {
  WALLET_XRAY: feature("WALLET_XRAY", "analysis.daily"),
  // Rendered from the same completed analysis as Wallet X-Ray and creates no
  // additional chain work, so it draws on the same quota (types.ts).
  ATTACK_MY_WALLET: feature("ATTACK_MY_WALLET", "analysis.daily"),
  // A read over persisted analysis; bounded per minute, not by plan.
  WALLET_CONTEXT: feature("WALLET_CONTEXT", null),
  COMPARE: feature("COMPARE", "compare.daily"),
  MONITOR: feature("MONITOR", "monitors.active"),
  ASK_AEGIX: feature("ASK_AEGIX", "ask.daily"),
  MARKETS: feature("MARKETS", "markets.daily"),
  SAVED_ANALYSES: feature("SAVED_ANALYSES", null),
  SAVED_COMPARISONS: feature("SAVED_COMPARISONS", null),
  DEVELOPER_API: feature("DEVELOPER_API", "api.daily"),
  API_KEYS: feature("API_KEYS", "apiKeys.active"),
  WEBHOOKS: feature("WEBHOOKS", "webhooks.active")
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/** Whether a plan includes a feature. Quota is asked separately. */
export function canUseFeature(planCode: PlanCode, key: FeatureKey): boolean {
  return FEATURE_REGISTRY[key].plans.includes(planCode);
}

/** The entitlement that bounds a feature's usage, or null when unmetered. */
export function featureQuotaKey(key: FeatureKey): EntitlementKey | null {
  return FEATURE_REGISTRY[key].quota;
}
