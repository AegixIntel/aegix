/**
 * D11 billing lifecycle sweep, see docs/milestone-d11.md.
 *
 * Subscriptions age whether or not anyone calls the API: periods end, grace
 * windows close, trials run out. This sweep is what moves those rows, and
 * what raises the invoice for a period that has just closed.
 *
 * It is safe to run concurrently on several worker replicas. Every
 * transition it applies carries a deterministic event key derived from the
 * boundary being crossed, so a second replica computes the same transition,
 * hits the unique index on `billing_events.event_key`, and changes nothing.
 * That is the same idempotency anchor developer usage metering uses for
 * request_id (D6-D §75).
 */

import type { AppConfig } from "@aegix/config";
import type { AegixLogger } from "@aegix/logging";
import { createBillingRepo, createMonitorRepo, type Sql, type SubscriptionRow } from "@aegix/database";
import {
  applyBillingAction,
  buildPlanCatalog,
  computeInvoice,
  findPlan,
  isPlanCode,
  rollUpUsage,
  summarizeUsage,
  USAGE_DIMENSIONS,
  type BillingAction,
  type BillingStore,
  type PlanCode,
  type PlanDefinition
} from "@aegix/billing";

/** How many due subscriptions one sweep will process. */
const SWEEP_BATCH = 200;

export interface BillingLifecycleContext {
  config: AppConfig;
  sql: Sql;
  logger: AegixLogger;
}

export interface BillingLifecycleResult {
  scanned: number;
  renewed: number;
  expired: number;
  invoiced: number;
  skipped: number;
  failed: number;
}

/** The billing catalog as the worker sees it: same config, same numbers. */
export function workerPlanCatalog(config: AppConfig): PlanDefinition[] {
  return buildPlanCatalog(
    {
      analysisDaily: config.FREE_USER_DAILY_LIMIT,
      compareDaily: config.COMPARE_DAILY_USER_LIMIT,
      askDaily: config.ASK_AEGIX_DAILY_QUOTA,
      marketsDaily: config.MARKETS_DAILY_QUOTA,
      monitorsActive: config.MAX_ACTIVE_MONITORS_PER_USER,
      apiKeysActive: config.MAX_ACTIVE_API_KEYS_PER_USER,
      webhooksActive: config.MAX_ACTIVE_WEBHOOKS_PER_USER,
      apiDaily: config.DEVELOPER_DAILY_QUOTA
    },
    config.BILLING_CURRENCY
  );
}

/**
 * The transition a due subscription needs, and the boundary that caused it.
 * The boundary goes into the event key, so re-deciding the same crossing
 * produces the same key.
 */
export function decideLifecycleAction(
  row: SubscriptionRow,
  now: Date
): { action: BillingAction; boundary: string; reason: string } | null {
  const at = now.getTime();

  // A past-due subscription has exactly two futures: it recovers (a payment
  // provider tells us so) or its grace window closes and it ends. It never
  // renews — that would advance the period and silently clear the failure.
  if (row.status === "PAST_DUE") {
    // A closed grace window ends it. Entitlements have already degraded to
    // free (the resolver does not wait for this sweep); this makes the row
    // say so too.
    if (row.grace_period_end && Date.parse(row.grace_period_end) <= at) {
      return { action: "EXPIRE", boundary: row.grace_period_end, reason: "GRACE_ELAPSED" };
    }
    return null;
  }

  // A trial cannot convert without a way to charge for what comes next, and
  // this baseline has no payment provider (architecture.md PR-12), so an
  // ended trial ends the subscription. Conversion arrives with the provider.
  if (row.status === "TRIALING" && row.trial_end && Date.parse(row.trial_end) <= at) {
    return { action: "EXPIRE", boundary: row.trial_end, reason: "TRIAL_ENDED" };
  }

  if (Date.parse(row.current_period_end) <= at) {
    // RENEW handles both outcomes: it advances the period, or ends the
    // subscription when cancellation was already scheduled.
    return { action: "RENEW", boundary: row.current_period_end, reason: "PERIOD_ELAPSED" };
  }

  return null;
}

function createStore(repo: ReturnType<typeof createBillingRepo>): BillingStore {
  return {
    async load(userId) {
      const row = await repo.getSubscription(userId);
      if (!row) return null;
      return {
        planCode: row.plan_code as PlanCode,
        status: row.status,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        gracePeriodEnd: row.grace_period_end,
        trialEnd: row.trial_end
      };
    },
    async save(input) {
      const result = await repo.applyTransition({
        userId: input.userId,
        subscription: {
          planCode: input.subscription.planCode,
          status: input.subscription.status,
          currentPeriodStart: input.subscription.currentPeriodStart,
          currentPeriodEnd: input.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: input.subscription.cancelAtPeriodEnd,
          gracePeriodEnd: input.subscription.gracePeriodEnd,
          trialEnd: input.subscription.trialEnd,
          provider: "manual",
          providerRef: null
        },
        event: {
          eventType: input.event.type,
          fromStatus: input.event.fromStatus === "NONE" ? null : input.event.fromStatus,
          toStatus: input.event.toStatus,
          fromPlan: input.event.fromPlan,
          toPlan: input.event.toPlan,
          detail: input.event.detail,
          eventKey: input.eventKey,
          occurredAt: input.event.occurredAt
        },
        profilePlan: input.profilePlan
      });
      return result.applied;
    }
  };
}

export async function runBillingLifecycle(
  ctx: BillingLifecycleContext,
  now: Date = new Date()
): Promise<BillingLifecycleResult> {
  const { config, sql, logger } = ctx;
  const result: BillingLifecycleResult = { scanned: 0, renewed: 0, expired: 0, invoiced: 0, skipped: 0, failed: 0 };
  if (!config.ENABLE_BILLING) return result;

  const repo = createBillingRepo(sql);
  const monitorRepo = createMonitorRepo(sql);
  const store = createStore(repo);
  const catalog = workerPlanCatalog(config);

  const due = await repo.dueForLifecycle(now, SWEEP_BATCH);
  result.scanned = due.length;

  for (const row of due) {
    const decision = decideLifecycleAction(row, now);
    if (!decision) {
      result.skipped += 1;
      continue;
    }
    try {
      const applied = await applyBillingAction(store, catalog, {
        userId: row.user_id,
        action: decision.action,
        now,
        graceDays: config.BILLING_GRACE_DAYS,
        // Deterministic: the boundary being crossed identifies the
        // transition, so concurrent replicas and retries converge.
        eventKey: `${row.user_id}:${decision.reason}:${decision.boundary}`
      });

      if (!applied.applied) {
        result.skipped += 1;
        continue;
      }
      if (applied.subscription.status === "EXPIRED") result.expired += 1;
      else result.renewed += 1;

      // The period that just closed is the one being invoiced. It is the
      // period the row held before the transition, not the new one.
      if (decision.action === "RENEW" && isPlanCode(row.plan_code)) {
        const issued = await issueInvoiceForPeriod({
          repo,
          catalog,
          countActiveMonitors: (userId) => monitorRepo.countActiveForUser(userId),
          userId: row.user_id,
          planCode: row.plan_code,
          subscriptionId: row.id,
          periodStart: row.current_period_start,
          periodEnd: row.current_period_end
        });
        if (issued) result.invoiced += 1;
      }

      logger.info("billing lifecycle transition", {
        subscriptionId: row.id,
        action: decision.action,
        reason: decision.reason,
        toStatus: applied.subscription.status
      });
    } catch (error) {
      // One failing subscription must not stop the sweep: the rest are
      // independent, and the next run retries this one with the same key.
      result.failed += 1;
      logger.error("billing lifecycle transition failed", {
        subscriptionId: row.id,
        action: decision.action,
        error: error instanceof Error ? error.message : "unknown"
      });
    }
  }

  return result;
}

/**
 * Raises or refreshes the invoice for a closed period. Derived from the plan
 * and the metered usage, so re-running it updates the same row rather than
 * billing twice. A zero-total period still gets a row: "you owed nothing" is
 * a useful record, and a missing invoice is indistinguishable from a bug.
 */
export async function issueInvoiceForPeriod(input: {
  repo: ReturnType<typeof createBillingRepo>;
  catalog: readonly PlanDefinition[];
  countActiveMonitors(userId: string): Promise<number>;
  userId: string;
  planCode: PlanCode;
  subscriptionId: string | null;
  periodStart: string;
  periodEnd: string;
}): Promise<boolean> {
  const plan = findPlan(input.catalog, input.planCode);
  if (!plan) return false;

  const [records, apiUnits, activeMonitors] = await Promise.all([
    input.repo.usageForPeriod(input.userId, input.periodStart, input.periodEnd),
    input.repo.developerUnitsForPeriod(input.userId, input.periodStart, input.periodEnd),
    input.countActiveMonitors(input.userId)
  ]);
  const summary = summarizeUsage(
    rollUpUsage({ records, apiUnits, activeMonitors }),
    plan.entitlements,
    { start: input.periodStart, end: input.periodEnd },
    USAGE_DIMENSIONS
  );
  const draft = computeInvoice(plan, summary);

  await input.repo.upsertInvoice({
    userId: input.userId,
    subscriptionId: input.subscriptionId,
    planCode: draft.planCode,
    currency: draft.currency,
    periodStart: draft.periodStart,
    periodEnd: draft.periodEnd,
    // Nothing can be settled without a payment provider, so an invoice with
    // a balance is raised OPEN and stays OPEN until one exists.
    status: draft.totalCents > 0 ? "OPEN" : "DRAFT",
    lines: draft.lines as never,
    subtotalCents: draft.subtotalCents,
    totalCents: draft.totalCents,
    engineVersion: draft.engineVersion
  });
  return true;
}
