/**
 * Operator plan grant (D11).
 *
 * AEGIX V1 provisions paid plans manually: an identity requests an upgrade in
 * the Billing UI, the operator arranges payment, then grants the plan here.
 * Self-service payment processing is post-launch scope. The grant is not a
 * database poke: it goes through the same state machine and writes the same
 * `billing_events` entry as any other transition, so the ledger stays a
 * complete history of how every subscription reached its current state.
 *
 *   pnpm billing:grant -- --requests
 *   pnpm billing:grant -- --user <uuid> --plan pro
 *   pnpm billing:grant -- --user <uuid> --action CANCEL
 *   pnpm billing:grant -- --user <uuid> --show
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "@aegix/config";
import { createDb, createBillingRepo } from "@aegix/database";
import {
  applyBillingAction,
  buildPlanCatalog,
  isPlanCode,
  type BillingAction,
  type BillingStore,
  type PlanCode
} from "@aegix/billing";

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
  --requests             list open upgrade requests, change nothing
  --user <uuid>          required otherwise, the profile id to act on
  --plan <code>          plan for SUBSCRIBE / CHANGE_PLAN (free is not a subscription)
  --action <ACTION>      one of ${GRANTABLE.join(", ")}; defaults to SUBSCRIBE/CHANGE_PLAN
  --show                 print the current subscription, open request and recent ledger, change nothing`);
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const listRequests = process.argv.includes("--requests");
  const userArg = arg("user");
  if (!listRequests && !userArg) usage("--user is required");

  const sql = createDb(config.DATABASE_URL);
  const repo = createBillingRepo(sql);
  const catalog = buildPlanCatalog(
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

  try {
    if (listRequests) {
      const open = await repo.listOpenUpgradeRequests(200);
      console.log(`open upgrade requests (${open.length}):`);
      for (const request of open) {
        console.log(`  ${request.updated_at}  user ${request.user_id}  plan ${request.plan_code}  contact ${request.contact ?? "-"}`);
      }
      return;
    }

    const userId = userArg as string;
    const current = await repo.getSubscription(userId);

    if (process.argv.includes("--show")) {
      console.log("subscription:", current ?? "(none — free plan)");
      const request = await repo.getOpenUpgradeRequest(userId);
      console.log("open upgrade request:", request ? `${request.plan_code} since ${request.updated_at}` : "(none)");
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

    const store: BillingStore = {
      async load(id) {
        const row = await repo.getSubscription(id);
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
            // The ledger records that a human did this, and which run did it.
            detail: { ...input.event.detail, grantedBy: "operator", grantId: randomUUID() },
            eventKey: input.eventKey,
            occurredAt: input.event.occurredAt
          },
          profilePlan: input.profilePlan
        });
        return result.applied;
      }
    };

    const result = await applyBillingAction(store, catalog, {
      userId,
      action,
      planCode: planCode ?? undefined,
      now: new Date(),
      trialDays: config.BILLING_TRIAL_DAYS,
      graceDays: config.BILLING_GRACE_DAYS
    });

    console.log(`${result.event.type}: ${result.event.fromPlan} → ${result.event.toPlan} (${result.subscription.status})`);
    console.log(`period ${result.subscription.currentPeriodStart} .. ${result.subscription.currentPeriodEnd}`);
    if (!result.applied) console.log("no change: this exact transition was already in the ledger");
    // A granted plan answers the identity's open request.
    if (result.applied && (action === "SUBSCRIBE" || action === "CHANGE_PLAN")) {
      if ((await repo.fulfillUpgradeRequest(userId)) > 0) console.log("upgrade request fulfilled");
    }
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "plan grant failed");
  process.exitCode = 1;
});
