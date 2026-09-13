/**
 * D11 billing surface, see docs/milestone-d11.md.
 *
 * Read paths (plans, subscription, usage, invoices, ledger) are always
 * available while billing is enabled. Write paths are deliberately narrow:
 *
 *   starting or changing a paid subscription requires a payment provider;
 *   ending one never does.
 *
 * This baseline ships the `manual` provider only (architecture.md PR-12), so
 * an upgrade answers PAYMENT_PROVIDER_REQUIRED rather than quietly creating a
 * paid subscription nobody paid for. Operators grant plans with
 * `scripts/grant-plan.ts`, which goes through the same state machine and
 * writes the same ledger entry.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { BillingRepo } from "@aegix/database";
import {
  BillingError,
  applyBillingAction,
  findPlan,
  isPlanCode,
  rollUpUsage,
  summarizeUsage,
  type BillingAction,
  type BillingStore,
  type MeteredUsage,
  type PlanCode,
  USAGE_DIMENSIONS
} from "@aegix/billing";
import type { EntitlementService } from "./entitlements.js";
import { toSubscriptionState } from "./entitlements.js";

export interface BillingDeps {
  app: FastifyInstance;
  config: AppConfig;
  repo: BillingRepo;
  entitlements: EntitlementService;
  /** Payment processor seam; `manual` in this baseline. */
  provider: { name: string; supportsSelfServe: boolean };
  requireUser(req: FastifyRequest, reply: FastifyReply): Promise<{ id: string; isAnonymous: boolean } | null>;
  /** Active monitors are a level dimension, counted at read time. */
  countActiveMonitors(userId: string): Promise<number>;
  logger: { info(msg: string, context?: Record<string, unknown>): void; warn(msg: string, context?: Record<string, unknown>): void };
}

/** Adapts the persistence repo to the pure package's store port. */
export function createBillingStore(repo: BillingRepo): BillingStore {
  return {
    async load(userId) {
      return toSubscriptionState(await repo.getSubscription(userId));
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

/**
 * Fetches the period's counters and rolls them up. The mapping itself lives
 * in @aegix/billing so the worker's invoice and this dashboard can never
 * disagree about what a usage row means.
 */
export async function meteredUsageForPeriod(
  repo: BillingRepo,
  countActiveMonitors: (userId: string) => Promise<number>,
  userId: string,
  periodStart: string,
  periodEnd: string
): Promise<MeteredUsage[]> {
  const [records, apiUnits, activeMonitors] = await Promise.all([
    repo.usageForPeriod(userId, periodStart, periodEnd),
    repo.developerUnitsForPeriod(userId, periodStart, periodEnd),
    countActiveMonitors(userId)
  ]);
  return rollUpUsage({ records, apiUnits, activeMonitors });
}

const ERROR_STATUS: Record<string, number> = {
  UNKNOWN_PLAN: 400,
  RETIRED_PLAN: 409,
  INVALID_TRANSITION: 409,
  PAYMENT_PROVIDER_REQUIRED: 501,
  NOT_SUPPORTED: 501
};

export function registerBilling(deps: BillingDeps): void {
  const { app, config, repo, entitlements, provider, logger, countActiveMonitors } = deps;
  const store = createBillingStore(repo);
  const rate = { rateLimit: { max: 30, timeWindow: "1 minute" } };

  function planView(code: PlanCode) {
    const plan = findPlan(entitlements.catalog, code);
    if (!plan) return null;
    return {
      code: plan.code,
      name: plan.name,
      tier: plan.tier,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      entitlements: plan.entitlements,
      catalogVersion: plan.catalogVersion
    };
  }

  async function admit(req: FastifyRequest, reply: FastifyReply) {
    if (!config.ENABLE_BILLING) {
      reply.code(403).send({ code: "FEATURE_DISABLED", message: "Billing is disabled on this deployment" });
      return null;
    }
    const user = await deps.requireUser(req, reply);
    if (!user) return null;
    if (user.isAnonymous) {
      reply.code(401).send({ code: "UNAUTHENTICATED", message: "Billing requires a registered identity" });
      return null;
    }
    await entitlements.syncCatalog();
    return user;
  }

  function failed(error: unknown, reply: FastifyReply, requestId: string): FastifyReply {
    if (error instanceof BillingError) {
      return reply.code(ERROR_STATUS[error.code] ?? 400).send({ code: error.code, message: error.message, requestId });
    }
    throw error;
  }

  async function act(userId: string, action: BillingAction, planCode?: PlanCode) {
    const result = await applyBillingAction(store, entitlements.catalog, {
      userId,
      action,
      planCode,
      now: new Date(),
      trialDays: config.BILLING_TRIAL_DAYS,
      graceDays: config.BILLING_GRACE_DAYS
    });
    // The replica that made the change must not keep serving the old plan.
    entitlements.invalidate(userId);
    return result;
  }

  // The catalog is public: pricing and limits are not a secret, and the
  // marketing site renders from the same source the API enforces.
  app.get("/v1/billing/plans", { config: rate }, async (_req, reply) => {
    if (!config.ENABLE_BILLING) {
      return reply.code(403).send({ code: "FEATURE_DISABLED", message: "Billing is disabled on this deployment" });
    }
    return {
      plans: entitlements.catalog.map((plan) => planView(plan.code)),
      currency: config.BILLING_CURRENCY,
      selfServe: provider.supportsSelfServe,
      provider: provider.name
    };
  });

  app.get("/v1/billing/subscription", { config: rate }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const [resolved, row, request] = await Promise.all([
      entitlements.resolve(user.id),
      repo.getSubscription(user.id),
      repo.getOpenUpgradeRequest(user.id)
    ]);
    return {
      plan: planView(resolved.planCode),
      upgradeRequest: request ? { plan: request.plan_code, status: request.status, requestedAt: request.updated_at } : null,
      subscribedPlan: planView(resolved.subscribedPlanCode),
      status: resolved.status,
      degraded: resolved.degraded,
      entitlements: resolved.entitlements,
      period: resolved.period,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
      gracePeriodEnd: row?.grace_period_end ?? null,
      trialEnd: row?.trial_end ?? null,
      selfServe: provider.supportsSelfServe,
      engineVersion: resolved.engineVersion
    };
  });

  app.get("/v1/billing/usage", { config: rate }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const resolved = await entitlements.resolve(user.id);
    const usage = await meteredUsageForPeriod(repo, countActiveMonitors, user.id, resolved.period.start, resolved.period.end);
    const summary = summarizeUsage(usage, resolved.entitlements, resolved.period, USAGE_DIMENSIONS);
    return {
      planCode: resolved.planCode,
      period: summary.period,
      days: summary.days,
      dimensions: summary.dimensions,
      engineVersion: resolved.engineVersion
    };
  });

  app.get<{ Querystring: { limit?: number } }>("/v1/billing/invoices", {
    config: rate,
    schema: { querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } } }
  }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const limit = Math.min(req.query.limit ?? config.BILLING_HISTORY_LIMIT, config.BILLING_HISTORY_LIMIT);
    return { invoices: await repo.listInvoices(user.id, limit) };
  });

  app.get<{ Params: { id: string } }>("/v1/billing/invoices/:id", { config: rate }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ code: "INVALID_REQUEST", message: "Invalid invoice id" });
    const invoice = await repo.getInvoice(user.id, req.params.id);
    if (!invoice) return reply.code(404).send({ code: "NOT_FOUND", message: "Invoice not found" });
    return { invoice };
  });

  app.get<{ Querystring: { limit?: number } }>("/v1/billing/events", {
    config: rate,
    schema: { querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } } }
  }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const limit = Math.min(req.query.limit ?? config.BILLING_HISTORY_LIMIT, config.BILLING_HISTORY_LIMIT);
    return { events: await repo.listEvents(user.id, limit) };
  });

  app.post<{ Body: { plan: string } }>("/v1/billing/subscription/change", {
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["plan"],
        properties: { plan: { type: "string", minLength: 2, maxLength: 32 } }
      }
    }
  }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    if (!isPlanCode(req.body.plan)) {
      return reply.code(400).send({ code: "UNKNOWN_PLAN", message: `Unknown plan: ${req.body.plan}`, requestId });
    }
    // Refuse before touching the state machine: creating a paid subscription
    // without a way to collect payment would be a lie in the ledger.
    if (!provider.supportsSelfServe) {
      return reply.code(501).send({
        code: "PAYMENT_PROVIDER_REQUIRED",
        message: "This deployment has no payment provider configured; paid plans are granted by an operator",
        requestId
      });
    }
    const current = await repo.getSubscription(user.id);
    const action: BillingAction = current && current.status !== "EXPIRED" ? "CHANGE_PLAN" : "SUBSCRIBE";
    try {
      const result = await act(user.id, action, req.body.plan);
      logger.info("billing transition", { requestId, action, event: result.event.type, applied: result.applied });
      return { status: result.subscription.status, plan: planView(result.subscription.planCode), applied: result.applied };
    } catch (error) {
      return failed(error, reply, requestId);
    }
  });

  // V1 manual provisioning: the identity asks for a paid plan, an operator
  // arranges payment and grants it (`pnpm billing:grant`). The request is
  // intent only — it never creates or changes a subscription.
  app.post<{ Body: { plan: string; contact?: string } }>("/v1/billing/upgrade-request", {
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["plan"],
        properties: {
          plan: { type: "string", minLength: 2, maxLength: 32 },
          contact: { type: "string", maxLength: 200 }
        }
      }
    }
  }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    const plan = isPlanCode(req.body.plan) ? findPlan(entitlements.catalog, req.body.plan) : undefined;
    if (!plan || plan.priceCents <= 0 || plan.status !== "ACTIVE") {
      return reply.code(400).send({ code: "UNKNOWN_PLAN", message: "That plan cannot be requested", requestId });
    }
    const current = await repo.getSubscription(user.id);
    const currentTier = current && current.status !== "EXPIRED" ? findPlan(entitlements.catalog, current.plan_code as PlanCode)?.tier ?? 0 : 0;
    if (plan.tier <= currentTier) {
      return reply.code(409).send({ code: "ALREADY_ON_PLAN", message: "Your current plan already includes this plan", requestId });
    }
    const contact = req.body.contact?.trim() || null;
    const request = await repo.requestUpgrade(user.id, plan.code, contact);
    // The contact detail stays out of the log.
    logger.info("billing upgrade requested", { requestId, plan: plan.code });
    return reply.code(201).send({
      request: { plan: request.plan_code, status: request.status, requestedAt: request.updated_at }
    });
  });

  app.post<{ Body: { immediate?: boolean } }>("/v1/billing/subscription/cancel", {
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        properties: { immediate: { type: "boolean" } }
      }
    }
  }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    // Ending a subscription never needs a payment provider: an identity can
    // always stop paying, whatever this deployment can or cannot charge.
    const action: BillingAction = req.body?.immediate === true ? "CANCEL_IMMEDIATELY" : "CANCEL";
    try {
      const result = await act(user.id, action);
      logger.info("billing transition", { requestId, action, event: result.event.type, applied: result.applied });
      return {
        status: result.subscription.status,
        cancelAtPeriodEnd: result.subscription.cancelAtPeriodEnd,
        effectiveAt: result.subscription.currentPeriodEnd
      };
    } catch (error) {
      return failed(error, reply, requestId);
    }
  });

  app.post("/v1/billing/subscription/resume", {
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } }
  }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    try {
      const result = await act(user.id, "RESUME");
      logger.info("billing transition", { requestId, action: "RESUME", event: result.event.type, applied: result.applied });
      return { status: result.subscription.status, cancelAtPeriodEnd: result.subscription.cancelAtPeriodEnd };
    } catch (error) {
      return failed(error, reply, requestId);
    }
  });
}
