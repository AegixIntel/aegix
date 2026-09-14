/**
 * D11 entitlement service: the single place the API asks "what is this
 * identity allowed to do right now".
 *
 * Every limit that used to be read straight off AppConfig at an enforcement
 * point now comes from here. The free plan is built from those same config
 * values, so an identity with no subscription — which is every identity
 * today — resolves to exactly the limits that were enforced before D11.
 * That property is what makes it safe to wire this into live paths, and it
 * is asserted in `entitlements.test.ts`.
 *
 * When ENABLE_BILLING is false the service short-circuits to the baseline
 * and never touches the database.
 */

import type { AppConfig } from "@aegix/config";
import type { BillingRepo, SubscriptionRow } from "@aegix/database";
import {
  buildPlanCatalog,
  canUseFeature as planIncludesFeature,
  catalogViolations,
  resolveEntitlements,
  type EntitlementBaseline,
  type EntitlementKey,
  type FeatureKey,
  type PlanDefinition,
  type ResolvedEntitlements,
  type SubscriptionState
} from "@aegix/billing";

/**
 * How long a resolved subscription is reused before it is read again.
 * Bounds the staleness a plan change can have across API replicas; the
 * replica that served the change invalidates its own entry immediately.
 */
const RESOLUTION_TTL_MS = 30_000;

export function baselineFromConfig(config: AppConfig): EntitlementBaseline {
  return {
    analysisDaily: config.FREE_USER_DAILY_LIMIT,
    compareDaily: config.COMPARE_DAILY_USER_LIMIT,
    askDaily: config.ASK_AEGIX_DAILY_QUOTA,
    marketsDaily: config.MARKETS_DAILY_QUOTA,
    monitorsActive: config.MAX_ACTIVE_MONITORS_PER_USER,
    apiKeysActive: config.MAX_ACTIVE_API_KEYS_PER_USER,
    webhooksActive: config.MAX_ACTIVE_WEBHOOKS_PER_USER,
    apiDaily: config.DEVELOPER_DAILY_QUOTA
  };
}

/** Storage row → the shape the pure resolver understands. */
export function toSubscriptionState(row: SubscriptionRow | null): SubscriptionState | null {
  if (!row) return null;
  return {
    planCode: row.plan_code as SubscriptionState["planCode"],
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    gracePeriodEnd: row.grace_period_end,
    trialEnd: row.trial_end
  };
}

export interface EntitlementServiceDeps {
  config: AppConfig;
  repo: BillingRepo;
  logger: { warn(msg: string, context?: Record<string, unknown>): void };
}

export interface EntitlementService {
  readonly catalog: PlanDefinition[];
  /** Resolved entitlements for an identity; free baseline for anonymous. */
  resolve(userId: string | null): Promise<ResolvedEntitlements>;
  /** One limit, the common case at an enforcement point. */
  limit(userId: string | null, key: EntitlementKey): Promise<number>;
  /**
   * Whether the identity's enforced plan includes a feature. How much of it
   * may be used is the separate `limit()` question.
   */
  canUseFeature(userId: string | null, feature: FeatureKey): Promise<boolean>;
  /** Drops the cached resolution after a transition on this replica. */
  invalidate(userId: string): void;
  /** Idempotently persists the in-process catalog snapshot. */
  syncCatalog(): Promise<void>;
}

export function createEntitlementService(deps: EntitlementServiceDeps): EntitlementService {
  const { config, repo, logger } = deps;
  const catalog = buildPlanCatalog(baselineFromConfig(config), config.BILLING_CURRENCY);

  // A non-monotonic catalog would let an upgrade silently reduce a paying
  // customer's limits. It can only happen through a misconfiguration, so it
  // is reported loudly and the catalog is still served: resolveEntitlements
  // floors every plan at the free baseline, so nobody is left worse off.
  const violations = catalogViolations(catalog);
  if (violations.length > 0) logger.warn("plan catalog is not monotonic", { violations });

  const cache = new Map<string, { at: number; subscription: SubscriptionState | null }>();
  let syncPromise: Promise<void> | null = null;

  const freeResolution = () => resolveEntitlements(catalog, null, new Date());

  async function readSubscription(userId: string): Promise<SubscriptionState | null> {
    const cached = cache.get(userId);
    const now = Date.now();
    if (cached && now - cached.at < RESOLUTION_TTL_MS) return cached.subscription;
    const subscription = toSubscriptionState(await repo.getSubscription(userId));
    cache.set(userId, { at: now, subscription });
    return subscription;
  }

  async function resolve(userId: string | null): Promise<ResolvedEntitlements> {
    if (!config.ENABLE_BILLING || !userId) return freeResolution();
    try {
      return resolveEntitlements(catalog, await readSubscription(userId), new Date());
    } catch (error) {
      // Entitlement resolution must never take the product down. A read
      // failure falls back to the free baseline: the identity keeps working
      // at the limits everyone gets, and the failure is logged.
      logger.warn("entitlement resolution failed, falling back to free", {
        error: error instanceof Error ? error.message : "unknown"
      });
      return freeResolution();
    }
  }

  async function syncCatalog(): Promise<void> {
    if (!config.ENABLE_BILLING) return;
    // Once per process: the catalog snapshot is written the first time a
    // billing surface is used rather than at boot, so a briefly unavailable
    // database cannot stop the API from starting.
    if (!syncPromise) {
      syncPromise = repo
        .syncPlans(
          catalog.map((plan) => ({
            code: plan.code,
            name: plan.name,
            tier: plan.tier,
            priceCents: plan.priceCents,
            currency: plan.currency,
            interval: plan.interval,
            entitlements: plan.entitlements as unknown as Record<string, number>,
            overageCents: plan.overageCents as Record<string, number>,
            status: plan.status,
            catalogVersion: plan.catalogVersion
          }))
        )
        .catch((error: unknown) => {
          // Allow a later request to retry; the snapshot serves operators
          // and referential integrity, never enforcement.
          syncPromise = null;
          logger.warn("plan catalog snapshot failed", { error: error instanceof Error ? error.message : "unknown" });
        });
    }
    return syncPromise;
  }

  return {
    catalog,
    resolve,
    async limit(userId, key) {
      return (await resolve(userId)).entitlements[key];
    },
    async canUseFeature(userId, feature) {
      // The enforced plan, not the subscribed one: a lapsed paid plan is
      // asked about as the free plan it has degraded to.
      return planIncludesFeature((await resolve(userId)).planCode, feature);
    },
    invalidate(userId) {
      cache.delete(userId);
    },
    syncCatalog
  };
}
