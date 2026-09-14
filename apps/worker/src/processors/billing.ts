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
import {
  createBillingRepo,
  createMonitorRepo,
  type Sql,
  type SubscriptionRow
} from "@aegix/database";
import {
  applyBillingAction,
  buildPlanCatalog,
  computeInvoice,
  DEFAULT_PLAN_CODE,
  findPlan,
  isPlanCode,
  resolveEntitlements,
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

/** How many identities one sweep will hold to their monitor entitlement. */
const ENTITLEMENT_SWEEP_BATCH = 500;

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
  monitorsPaused: number;
  monitorsResumed: number;
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
    // A scheduled cancellation ends here whatever the provider: RENEW covers
    // both outcomes (advance the period, or end the subscription when
    // cancellation was already scheduled), so this is not an unpaid period.
    if (row.cancel_at_period_end || row.status === "CANCELED") {
      return { action: "RENEW", boundary: row.current_period_end, reason: "PERIOD_ELAPSED" };
    }
    // A manually provisioned subscription has no processor to collect the
    // next period, so time passing must never renew it: that would hand out
    // a paid period nobody paid for. It ends unpaid, and only an operator
    // confirming payment on the period's invoice (scripts/grant-plan.ts,
    // `--mark-paid`) starts the next one.
    if (row.provider === "manual") {
      return { action: "EXPIRE", boundary: row.current_period_end, reason: "PERIOD_ELAPSED_UNPAID" };
    }
    // A processor-managed subscription renews on the provider's schedule;
    // this sweep only advances the row to match what the processor already
    // did. Removing manual auto-renewal must not touch this path.
    return { action: "RENEW", boundary: row.current_period_end, reason: "PERIOD_ELAPSED" };
  }

  return null;
}

export interface EntitlementScopedMonitor {
  id: string;
  status: string;
  created_at: string | Date;
}

/**
 * Which monitors the monitor entitlement pauses or resumes for one identity.
 * The oldest monitors keep running: the newest over the limit pause first,
 * and the oldest held by an entitlement pause resume first. A monitor its
 * owner paused (PAUSED) is never touched. Pure, so every replica decides the
 * same thing.
 */
export function decideMonitorEntitlement(
  monitors: readonly EntitlementScopedMonitor[],
  limit: number
): { pause: string[]; resume: string[] } {
  const ordered = [...monitors].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id)
  );
  const running = ordered.filter((m) => m.status === "ACTIVE" || m.status === "DEGRADED");
  const held = ordered.filter((m) => m.status === "ENTITLEMENT_PAUSED");
  const allowed = Math.max(0, limit);
  if (running.length > allowed) return { pause: running.slice(allowed).map((m) => m.id), resume: [] };
  return { pause: [], resume: held.slice(0, allowed - running.length).map((m) => m.id) };
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
          provider: input.provider,
          providerRef: input.providerRef
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
  const result: BillingLifecycleResult = {
    scanned: 0,
    renewed: 0,
    expired: 0,
    invoiced: 0,
    skipped: 0,
    failed: 0,
    monitorsPaused: 0,
    monitorsResumed: 0
  };
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
        eventKey: `${row.user_id}:${decision.reason}:${decision.boundary}`,
        // Preserve the row's provider: a manual expiry must not relabel a
        // processor-managed subscription.
        provider: row.provider,
        providerRef: row.provider_ref
      });

      if (!applied.applied) {
        result.skipped += 1;
        continue;
      }
      if (applied.subscription.status === "EXPIRED") result.expired += 1;
      else result.renewed += 1;

      // The period that just closed is the one being invoiced. It is the
      // period the row held before the transition, not the new one. Both
      // endings bill it: a renewal settles the period it renews from, and an
      // unpaid manual expiry still owes for the period it just used — that
      // invoice is what an operator marks paid to start the next one.
      const closedPeriodBilled =
        decision.reason === "PERIOD_ELAPSED" || decision.reason === "PERIOD_ELAPSED_UNPAID";
      if (closedPeriodBilled && isPlanCode(row.plan_code)) {
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

  // ---- Monitor entitlement (§5) ----
  // A running monitor keeps consuming checks, so unlike keys and webhook
  // endpoints it is held to the plan continuously: when the enforced plan no
  // longer covers an identity's running monitors, the newest pause
  // (ENTITLEMENT_PAUSED); when it covers them again, they resume. Nothing is
  // deleted. This runs whether or not a subscription row was due — a closed
  // grace window degrades entitlements before its row changes (§4).
  const freeMonitors =
    findPlan(catalog, DEFAULT_PLAN_CODE)?.entitlements["monitors.active"] ?? config.MAX_ACTIVE_MONITORS_PER_USER;
  const candidates = await monitorRepo.listEntitlementCandidates(freeMonitors, ENTITLEMENT_SWEEP_BATCH);
  for (const userId of candidates) {
    try {
      const allowed = resolveEntitlements(catalog, await store.load(userId), now).entitlements["monitors.active"];
      const decision = decideMonitorEntitlement(await monitorRepo.listEntitlementScoped(userId), allowed);
      const paused = await monitorRepo.pauseForEntitlement(userId, decision.pause);
      const resumed = await monitorRepo.resumeFromEntitlement(userId, decision.resume);
      result.monitorsPaused += paused;
      result.monitorsResumed += resumed;
      if (paused > 0 || resumed > 0) logger.info("monitor entitlement applied", { allowed, paused, resumed });
    } catch (error) {
      // Same isolation as the transitions above: the next sweep retries.
      result.failed += 1;
      logger.error("monitor entitlement enforcement failed", {
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
