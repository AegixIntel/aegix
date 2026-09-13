/**
 * Operator plan grant and manual invoice settlement (D11).
 *
 * This baseline ships no payment provider (architecture.md PR-12), so paid
 * plans are granted by an operator and renewed only when the operator
 * confirms the invoice payment. Neither action is a database poke: both go
 * through the same state machine and write the same `billing_events` entry as
 * any other transition, so the ledger stays a complete history of how every
 * subscription reached its current state.
 *
 *   pnpm billing:grant -- --user <uuid> --plan pro
 *   pnpm billing:grant -- --user <uuid> --action CANCEL
 *   pnpm billing:grant -- --user <uuid> --show
 *   pnpm billing:grant -- --invoice <id> --mark-paid
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "@aegix/config";
import {
  createBillingRepo,
  createDb,
  createMonitorRepo,
  type Sql,
  type SubscriptionRow
} from "@aegix/database";
import {
  applyBillingAction,
  buildPlanCatalog,
  findPlan,
  isPlanCode,
  paidRenewalAction,
  resolveEntitlements,
  type BillingAction,
  type BillingStore,
  type PlanCode,
  type PlanDefinition,
  type SubscriptionState
} from "@aegix/billing";
import { reconcileMonitorEntitlement } from "../apps/worker/src/processors/billing.js";

const GRANTABLE: readonly BillingAction[] = [
  "SUBSCRIBE",
  "CHANGE_PLAN",
  "CANCEL",
  "CANCEL_IMMEDIATELY",
  "RESUME",
  "RENEW",
  "PAYMENT_FAILED",
  "PAYMENT_RECOVERED",
  "EXPIRE"
];

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  --user <uuid>          the profile id to act on (required for a grant)
  --plan <code>          plan for SUBSCRIBE / CHANGE_PLAN (free is not a subscription)
  --action <ACTION>      one of ${GRANTABLE.join(", ")}; defaults to SUBSCRIBE/CHANGE_PLAN
  --invoice <id>         invoice to settle; requires --mark-paid
  --mark-paid            confirm payment: OPEN invoice → PAID, subscription extended one period
  --show                 print the current subscription and recent ledger, change nothing`);
  process.exit(1);
}

function toState(row: SubscriptionRow): SubscriptionState {
  return {
    planCode: row.plan_code as PlanCode,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    gracePeriodEnd: row.grace_period_end,
    trialEnd: row.trial_end
  };
}

function buildCatalog(config: ReturnType<typeof loadConfig>): PlanDefinition[] {
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
 * The store shared by the grant and settlement paths. It records that a human
 * did this, and which run did it, and (for a settlement) which invoice
 * authorised the transition.
 */
function createStore(
  repo: ReturnType<typeof createBillingRepo>,
  detail: Record<string, string> = {}
): BillingStore {
  return {
    async load(userId) {
      const row = await repo.getSubscription(userId);
      return row ? toState(row) : null;
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
          // The ledger records that a human did this, and which run did it.
          detail: { ...input.event.detail, grantedBy: "operator", grantId: randomUUID(), ...detail },
          eventKey: input.eventKey,
          occurredAt: input.event.occurredAt
        },
        profilePlan: input.profilePlan
      });
      return result.applied;
    }
  };
}

async function markInvoicePaid(input: {
  sql: Sql;
  config: ReturnType<typeof loadConfig>;
  repo: ReturnType<typeof createBillingRepo>;
  catalog: readonly PlanDefinition[];
  invoiceId: string;
  userId: string | null;
}): Promise<void> {
  const { sql, config, repo, catalog, invoiceId, userId } = input;

  const invoice = await repo.getInvoiceById(invoiceId);
  if (!invoice) throw new Error(`Unknown invoice: ${invoiceId}`);
  if (userId !== null && userId !== invoice.user_id) {
    throw new Error(`Invoice ${invoiceId} belongs to a different identity`);
  }

  // Idempotent: a replayed settlement changes nothing. Monitors are still
  // reconciled, so a run interrupted after the extension can finish its work.
  if (invoice.status === "PAID") {
    await reconcileMonitors(sql, catalog, invoice.user_id);
    console.log(`Invoice: ${invoice.id}`);
    console.log("Status: PAID (already settled — no change)");
    return;
  }
  if (invoice.status !== "OPEN") {
    throw new Error(`Cannot mark a ${invoice.status} invoice paid; only an OPEN invoice can be settled`);
  }
  if (!isPlanCode(invoice.plan_code)) throw new Error(`Unknown plan on invoice: ${invoice.plan_code}`);
  const plan = findPlan(catalog, invoice.plan_code);
  if (!plan || plan.status !== "ACTIVE") throw new Error(`Plan ${invoice.plan_code} is retired`);

  const current = await repo.getSubscription(invoice.user_id);
  const action = paidRenewalAction(current ? toState(current) : null);

  // The invoice id is the idempotency anchor: a retried settlement computes
  // the same event, hits the ledger's unique key and is absorbed, so the
  // period cannot advance twice.
  await applyBillingAction(createStore(repo, { invoiceId: invoice.id }), catalog, {
    userId: invoice.user_id,
    action,
    // Only a fresh SUBSCRIBE names a target plan; a RENEW acts on the plan
    // the subscription already holds.
    planCode: action === "SUBSCRIBE" ? (invoice.plan_code as PlanCode) : undefined,
    now: new Date(),
    // Confirmed payment means an active period, never a trial.
    trialDays: 0,
    graceDays: config.BILLING_GRACE_DAYS,
    eventKey: `invoice-paid:${invoice.id}`,
    provider: current?.provider ?? "manual",
    providerRef: current?.provider_ref ?? null
  });

  const settled = await repo.markInvoicePaid(invoice.id, new Date().toISOString());
  const after = await repo.getSubscription(invoice.user_id);
  await reconcileMonitors(sql, catalog, invoice.user_id);

  console.log(`Invoice: ${invoice.id}`);
  console.log(`Status: PAID${settled ? "" : " (already settled)"}`);
  console.log(`Subscription: ${after?.id ?? "(none)"}`);
  console.log(`Extended through: ${after?.current_period_end ?? "-"}`);
}

async function reconcileMonitors(
  sql: Sql,
  catalog: readonly PlanDefinition[],
  userId: string
): Promise<void> {
  const repo = createBillingRepo(sql);
  const row = await repo.getSubscription(userId);
  const allowed = resolveEntitlements(catalog, row ? toState(row) : null, new Date())
    .entitlements["monitors.active"];
  await reconcileMonitorEntitlement(createMonitorRepo(sql), userId, allowed);
}

async function runGrant(input: {
  config: ReturnType<typeof loadConfig>;
  repo: ReturnType<typeof createBillingRepo>;
  catalog: readonly PlanDefinition[];
  userId: string;
}): Promise<void> {
  const { config, repo, catalog, userId } = input;
  const current = await repo.getSubscription(userId);

  if (process.argv.includes("--show")) {
    console.log("subscription:", current ?? "(none — free plan)");
    const events = await repo.listEvents(userId, 10);
    console.log(`ledger (${events.length} most recent):`);
    for (const event of events) {
      console.log(`  ${event.occurred_at}  ${event.event_type}  ${event.from_plan ?? "-"} → ${event.to_plan}  (${event.to_status})`);
    }
    return;
  }

  const planArg = arg("plan");
  if (planArg !== null && !isPlanCode(planArg)) usage(`Unknown plan: ${planArg}`);
  const planCode = planArg as PlanCode | null;

  const actionArg = arg("action");
  if (actionArg !== null && !GRANTABLE.includes(actionArg as BillingAction)) usage(`Unknown action: ${actionArg}`);
  const action: BillingAction =
    (actionArg as BillingAction | null) ??
    (current && current.status !== "EXPIRED" ? "CHANGE_PLAN" : "SUBSCRIBE");

  if ((action === "SUBSCRIBE" || action === "CHANGE_PLAN") && !planCode) {
    usage(`--plan is required for ${action}`);
  }

  const result = await applyBillingAction(createStore(repo), catalog, {
    userId,
    action,
    planCode: planCode ?? undefined,
    now: new Date(),
    trialDays: config.BILLING_TRIAL_DAYS,
    graceDays: config.BILLING_GRACE_DAYS,
    provider: current?.provider ?? "manual",
    providerRef: current?.provider_ref ?? null
  });

  console.log(`${result.event.type}: ${result.event.fromPlan} → ${result.event.toPlan} (${result.subscription.status})`);
  console.log(`period ${result.subscription.currentPeriodStart} .. ${result.subscription.currentPeriodEnd}`);
  if (!result.applied) console.log("no change: this exact transition was already in the ledger");
}

async function main(): Promise<void> {
  const config = loadConfig();
  const invoiceId = arg("invoice");
  const markPaid = process.argv.includes("--mark-paid");
  if (invoiceId && !markPaid) usage("--invoice requires --mark-paid");

  const userId = arg("user");
  if (!invoiceId && !userId) usage("--user is required");

  const sql = createDb(config.DATABASE_URL);
  const repo = createBillingRepo(sql);
  const catalog = buildCatalog(config);

  try {
    if (invoiceId) {
      await markInvoicePaid({ sql, config, repo, catalog, invoiceId, userId });
      return;
    }
    await runGrant({ config, repo, catalog, userId: userId as string });
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "plan grant failed");
  process.exitCode = 1;
});
