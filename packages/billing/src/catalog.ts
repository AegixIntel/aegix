/**
 * Plan catalog, architecture.md §69 / §82.
 *
 * The catalog is derived from a single baseline: the limits the deployment
 * already runs on. The free plan IS that baseline, entitlement for
 * entitlement, so an identity with no subscription behaves exactly as it did
 * before D11 existed. Paid plans are the baseline scaled by a fixed factor
 * per entitlement family, which keeps "exact limits should be tuned based on
 * cost" (§82) a one-knob operation rather than a table of magic numbers.
 */

import {
  ENTITLEMENT_KEYS,
  PLAN_CATALOG_VERSION,
  PLAN_CODES,
  type Entitlements,
  type EntitlementKey,
  type PlanCode,
  type PlanDefinition
} from "./types.js";

/** The deployment's own limits, supplied by the caller from AppConfig. */
export interface EntitlementBaseline {
  analysisDaily: number;
  compareDaily: number;
  askDaily: number;
  marketsDaily: number;
  monitorsActive: number;
  apiKeysActive: number;
  webhooksActive: number;
  apiDaily: number;
}

/**
 * Entitlement families. Daily quotas buy throughput and active levels buy
 * concurrency; each scales differently because each costs the platform
 * differently.
 */
type EntitlementFamily = "DAILY" | "LEVEL";

const FAMILY: Readonly<Record<EntitlementKey, EntitlementFamily>> = {
  "analysis.daily": "DAILY",
  "compare.daily": "DAILY",
  "ask.daily": "DAILY",
  "markets.daily": "DAILY",
  "api.daily": "DAILY",
  "monitors.active": "LEVEL",
  "apiKeys.active": "LEVEL",
  "webhooks.active": "LEVEL"
};

/**
 * Per-plan scale over the baseline. Concurrency scales more conservatively
 * than throughput: an active monitor or webhook holds platform resources
 * continuously, while a daily quota only spreads work over a day.
 */
const PLAN_SCALE: Readonly<Record<PlanCode, Readonly<Record<EntitlementFamily, number>>>> = {
  free: { DAILY: 1, LEVEL: 1 },
  pro: { DAILY: 10, LEVEL: 5 },
  team: { DAILY: 40, LEVEL: 20 }
};

const PLAN_META: Readonly<Record<PlanCode, { name: string; tier: number; priceCents: number; interval: PlanDefinition["interval"] }>> = {
  free: { name: "Free", tier: 0, priceCents: 0, interval: "NONE" },
  pro: { name: "Pro", tier: 1, priceCents: 4900, interval: "MONTH" },
  team: { name: "Team", tier: 2, priceCents: 19900, interval: "MONTH" }
};

function baselineEntitlements(baseline: EntitlementBaseline): Entitlements {
  return {
    "analysis.daily": baseline.analysisDaily,
    "compare.daily": baseline.compareDaily,
    "ask.daily": baseline.askDaily,
    "markets.daily": baseline.marketsDaily,
    "monitors.active": baseline.monitorsActive,
    "apiKeys.active": baseline.apiKeysActive,
    "webhooks.active": baseline.webhooksActive,
    "api.daily": baseline.apiDaily
  };
}

/** Free-plan entitlements: the deployment baseline, unmodified. */
export function freeEntitlements(baseline: EntitlementBaseline): Entitlements {
  return baselineEntitlements(baseline);
}

function scaleEntitlements(base: Entitlements, code: PlanCode): Entitlements {
  const scale = PLAN_SCALE[code];
  const out = {} as Record<EntitlementKey, number>;
  for (const key of ENTITLEMENT_KEYS) {
    // A zero baseline means the surface is switched off for this deployment;
    // scaling must never turn it back on for a paying account.
    const value = base[key];
    out[key] = value === 0 ? 0 : value * scale[FAMILY[key]];
  }
  return out;
}

export function buildPlanCatalog(baseline: EntitlementBaseline, currency: string): PlanDefinition[] {
  const base = baselineEntitlements(baseline);
  return PLAN_CODES.map((code) => ({
    code,
    name: PLAN_META[code].name,
    tier: PLAN_META[code].tier,
    priceCents: PLAN_META[code].priceCents,
    currency,
    interval: PLAN_META[code].interval,
    entitlements: scaleEntitlements(base, code),
    // v1 ships hard caps only: no dimension is metered softly, so no invoice
    // can carry an overage line. See computeInvoice.
    overageCents: {},
    status: "ACTIVE" as const,
    catalogVersion: PLAN_CATALOG_VERSION
  }));
}

export function findPlan(catalog: readonly PlanDefinition[], code: string): PlanDefinition | null {
  return catalog.find((plan) => plan.code === code) ?? null;
}

/**
 * Catalog invariant: a higher tier never grants less of anything. Violating
 * this would let an upgrade silently reduce a customer's limits.
 */
export function catalogViolations(catalog: readonly PlanDefinition[]): string[] {
  const problems: string[] = [];
  const ordered = [...catalog].sort((a, b) => a.tier - b.tier);
  for (let i = 1; i < ordered.length; i++) {
    const lower = ordered[i - 1];
    const higher = ordered[i];
    if (!lower || !higher) continue;
    for (const key of ENTITLEMENT_KEYS) {
      if (higher.entitlements[key] < lower.entitlements[key]) {
        problems.push(`${higher.code}.${key} (${higher.entitlements[key]}) is below ${lower.code} (${lower.entitlements[key]})`);
      }
    }
    if (higher.priceCents < lower.priceCents) {
      problems.push(`${higher.code} costs less than ${lower.code}`);
    }
  }
  return problems;
}
