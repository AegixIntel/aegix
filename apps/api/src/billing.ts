/**
 * D11 billing surface, see docs/milestone-d11.md.
 *
 * Read paths (plans, subscription, usage, invoices, ledger) are always
 * available while billing is enabled. Write paths are deliberately narrow:
 *
 *   a paid subscription starts only at a payment processor's checkout;
 *   ending one never requires a processor.
 *
 * With the `manual` provider an upgrade answers PAYMENT_PROVIDER_REQUIRED,
 * and operators grant plans with `scripts/grant-plan.ts`, which goes through
 * the same state machine and writes the same ledger entry.
 *
 * With a processor configured, the browser asks for a checkout and is sent to
 * the processor's hosted payment form. The subscription exists only once the
 * processor says so — in a signed webhook, or in its own API response — never
 * because the browser came back to a success page.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "@aegix/config";
import type { BillingRepo, ProviderEventOutcome, SubscriptionRow } from "@aegix/database";
import {
  BillingError,
  applyBillingAction,
  findPlan,
  isPlanCode,
  profilePlanLabel,
  reconcileProviderSubscription,
  rollUpUsage,
  summarizeUsage,
  type BillingAction,
  type BillingStore,
  type MeteredUsage,
  type PaymentProvider,
  type PlanCode,
  type ProviderSubscriptionSnapshot,
  type ProviderSyncDecision,
  type ProviderWebhookEvent,
  type ProviderWebhooks,
  USAGE_DIMENSIONS
} from "@aegix/billing";
import type { EntitlementService } from "./entitlements.js";
import { toSubscriptionState } from "./entitlements.js";

export interface BillingDeps {
  app: FastifyInstance;
  config: AppConfig;
  repo: BillingRepo;
  entitlements: EntitlementService;
  /** Payment processor seam: `manual`, or a configured processor. */
  provider: PaymentProvider;
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
  NOT_SUPPORTED: 501,
  PROVIDER_UNAVAILABLE: 502,
  PROVIDER_REJECTED: 502
};

const LIVE_STATUSES: readonly string[] = ["TRIALING", "ACTIVE", "PAST_DUE"];

type SubscriptionEvent = Extract<ProviderWebhookEvent, { kind: "subscription" }>;

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

  /**
   * Applies processor-reported state for one identity. Webhooks and processor
   * API responses both land here, so they share one ordering and one ledger.
   */
  async function syncSnapshot(userId: string, snapshot: ProviderSubscriptionSnapshot, eventKey: string, source: string) {
    const result = await repo.applyProviderSync<ProviderSyncDecision>(userId, (row) => {
      const decision = reconcileProviderSubscription({
        current: toSubscriptionState(row),
        binding: row ? { provider: row.provider, subscriptionRef: row.provider_ref, observedAt: row.provider_observed_at } : null,
        snapshot,
        graceDays: config.BILLING_GRACE_DAYS
      });
      if (decision.kind === "unchanged") return { decision, write: null, observedAt: snapshot.observedAt };
      if (decision.kind !== "apply") return { decision, write: null, observedAt: null };
      const next = decision.subscription;
      const sameSubscription = row?.provider_ref === snapshot.subscriptionRef;
      return {
        decision,
        observedAt: null,
        write: {
          subscription: {
            planCode: next.planCode,
            status: next.status,
            currentPeriodStart: next.currentPeriodStart,
            currentPeriodEnd: next.currentPeriodEnd,
            cancelAtPeriodEnd: next.cancelAtPeriodEnd,
            gracePeriodEnd: next.gracePeriodEnd,
            trialEnd: next.trialEnd,
            provider: snapshot.provider,
            providerRef: snapshot.subscriptionRef,
            providerCustomerRef: snapshot.customerRef ?? (sameSubscription ? row?.provider_customer_ref ?? null : null),
            providerObservedAt: snapshot.observedAt
          },
          event: {
            eventType: decision.event.type,
            fromStatus: decision.event.fromStatus === "NONE" ? null : decision.event.fromStatus,
            toStatus: decision.event.toStatus,
            fromPlan: decision.event.fromPlan,
            toPlan: decision.event.toPlan,
            detail: { ...decision.event.detail, source },
            eventKey,
            occurredAt: decision.event.occurredAt
          },
          profilePlan: profilePlanLabel(next)
        }
      };
    });
    entitlements.invalidate(userId);
    const decision = result.decision;
    const outcome: ProviderEventOutcome =
      decision.kind === "apply" ? (result.applied ? "APPLIED" : "DUPLICATE")
      : decision.kind === "unchanged" ? "UNCHANGED"
      : decision.kind === "stale" ? "STALE"
      : "IGNORED";
    return { outcome, reason: decision.kind === "ignored" ? decision.reason : null, row: result.subscription };
  }

  /**
   * The identity a processor subscription belongs to: the one it is already
   * bound to, or the one whose checkout created it — found by the processor's
   * checkout reference or by the unguessable token this API handed the
   * processor. A user id the payload merely claims is never enough.
   */
  async function resolveSubscriber(event: SubscriptionEvent): Promise<string | null> {
    const bound = await repo.findSubscriberByProviderRef(provider.name, event.snapshot.subscriptionRef);
    if (bound) return bound;
    if (event.checkoutRef) {
      const checkout = await repo.findCheckoutByRef(provider.name, event.checkoutRef);
      if (checkout) return checkout.user_id;
    }
    if (event.checkoutToken) {
      const checkout = await repo.findCheckoutByToken(provider.name, event.checkoutToken);
      if (checkout) return checkout.user_id;
    }
    return null;
  }

  async function handleWebhook(req: FastifyRequest, reply: FastifyReply, webhooks: ProviderWebhooks) {
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    if (!config.ENABLE_BILLING) {
      // 503, not 403: the processor retries, so no event is lost while billing is switched off.
      return reply.code(503).send({ code: "FEATURE_DISABLED", message: "Billing is disabled on this deployment", requestId });
    }
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (typeof req.body !== "string" || !contentType.startsWith("application/json")) {
      return reply.code(415).send({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Webhooks must be application/json", requestId });
    }
    const rawBody = req.body;

    const verification = webhooks.verify({ rawBody, headers: req.headers, now: new Date() });
    if (!verification.valid) {
      // Operators see why; the sender learns only that it was refused.
      logger.warn("billing webhook refused", { requestId, provider: provider.name, reason: verification.reason });
      return reply.code(401).send({ code: "INVALID_SIGNATURE", message: "Webhook signature verification failed", requestId });
    }

    const event = webhooks.parse(rawBody);
    if (event.kind === "invalid") {
      logger.warn("billing webhook malformed", { requestId, provider: provider.name, reason: event.reason });
      return reply.code(400).send({ code: "INVALID_EVENT", message: "Webhook payload is not a valid event", requestId });
    }

    // Replay and redelivery: an event id is handled once.
    if (await repo.hasProviderEvent(provider.name, event.eventId)) {
      logger.info("billing webhook duplicate", { requestId, provider: provider.name, eventId: event.eventId, eventType: event.eventType });
      return { received: true, duplicate: true };
    }

    await entitlements.syncCatalog();
    let outcome: ProviderEventOutcome = "IGNORED";
    let reason: string | null = null;
    let userId: string | null = null;
    let subscriptionRef: string | null = null;

    if (event.kind === "subscription") {
      subscriptionRef = event.snapshot.subscriptionRef;
      userId = await resolveSubscriber(event);
      if (!userId) {
        reason = "UNKNOWN_SUBSCRIBER";
      } else {
        const synced = await syncSnapshot(userId, event.snapshot, `${provider.name}:${event.eventId}`, event.eventType);
        outcome = synced.outcome;
        reason = synced.reason;
      }
    } else if (event.kind === "unmapped") {
      subscriptionRef = event.subscriptionRef;
      reason = event.reason;
    } else {
      reason = "UNHANDLED_EVENT_TYPE";
    }

    // Recorded after processing: a failure above answers 500, and the
    // processor's retry gets a second chance instead of a false "duplicate".
    const recorded = await repo.recordProviderEvent({
      provider: provider.name,
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      outcome,
      reason,
      userId,
      subscriptionRef
    });
    logger.info("billing webhook processed", {
      requestId,
      provider: provider.name,
      eventId: event.eventId,
      eventType: event.eventType,
      outcome,
      reason
    });
    return { received: true, duplicate: !recorded, outcome };
  }

  /**
   * Cancel and resume for a processor-managed subscription go to the
   * processor; the processor's answer is what is recorded.
   */
  async function viaProcessor(
    userId: string,
    row: SubscriptionRow,
    action: "CANCEL" | "CANCEL_IMMEDIATELY" | "RESUME",
    reply: FastifyReply,
    requestId: string,
    respond: (row: SubscriptionRow) => unknown
  ) {
    if (row.provider !== provider.name || !row.provider_ref) {
      return reply.code(503).send({
        code: "PROVIDER_UNAVAILABLE",
        message: "This subscription is managed by a payment processor this deployment is not configured for",
        requestId
      });
    }
    const allowed =
      action === "RESUME" ? row.status === "CANCELED"
      : action === "CANCEL" ? LIVE_STATUSES.includes(row.status)
      : row.status !== "EXPIRED";
    if (!allowed) {
      return reply.code(409).send({ code: "INVALID_TRANSITION", message: `Cannot ${action} a subscription in state ${row.status}`, requestId });
    }
    try {
      const snapshot =
        action === "RESUME"
          ? await provider.resumeSubscription(row.provider_ref)
          : await provider.cancelSubscription(row.provider_ref, { immediate: action === "CANCEL_IMMEDIATELY" });
      const synced = await syncSnapshot(
        userId,
        snapshot,
        `${provider.name}:api:${snapshot.subscriptionRef}:${snapshot.status}:${snapshot.observedAt}`,
        "api"
      );
      logger.info("billing processor transition", { requestId, provider: provider.name, action, outcome: synced.outcome });
      return respond(synced.row ?? row);
    } catch (error) {
      return failed(error, reply, requestId);
    }
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
    const [resolved, row] = await Promise.all([entitlements.resolve(user.id), repo.getSubscription(user.id)]);
    return {
      plan: planView(resolved.planCode),
      subscribedPlan: planView(resolved.subscribedPlanCode),
      status: resolved.status,
      degraded: resolved.degraded,
      entitlements: resolved.entitlements,
      period: resolved.period,
      cancelAtPeriodEnd: row?.cancel_at_period_end ?? false,
      gracePeriodEnd: row?.grace_period_end ?? null,
      trialEnd: row?.trial_end ?? null,
      selfServe: provider.supportsSelfServe,
      /** Who manages this subscription: `manual`, a processor, or null for none. */
      managedBy: row?.provider ?? null,
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

  // ---- Checkout: the browser names a plan, and nothing else ----
  app.post<{ Body: { plan: string } }>("/v1/billing/checkout", {
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
    if (!provider.supportsSelfServe) {
      return reply.code(501).send({
        code: "PAYMENT_PROVIDER_REQUIRED",
        message: "This deployment has no payment provider configured; paid plans are granted by an operator",
        requestId
      });
    }
    // Price, amount and currency come from the server's plan → price map.
    // Any other field the browser sends is dropped by the schema.
    const plan = isPlanCode(req.body.plan) ? findPlan(entitlements.catalog, req.body.plan) : undefined;
    if (!plan || plan.priceCents <= 0 || plan.status !== "ACTIVE") {
      return reply.code(400).send({ code: "UNKNOWN_PLAN", message: "That plan cannot be purchased", requestId });
    }
    const current = await repo.getSubscription(user.id);
    if (current && current.status !== "EXPIRED") {
      return reply.code(409).send({
        code: "SUBSCRIPTION_EXISTS",
        message: "This identity already has a subscription; manage it from Plan & usage",
        requestId
      });
    }
    const checkoutToken = randomBytes(32).toString("hex");
    try {
      const session = await provider.createCheckout({ userId: user.id, plan, checkoutToken });
      await repo.recordCheckout({
        userId: user.id,
        provider: provider.name,
        checkoutRef: session.reference,
        token: checkoutToken,
        planCode: plan.code
      });
      logger.info("billing checkout created", { requestId, provider: provider.name, plan: plan.code });
      return { provider: session.provider, url: session.url, reference: session.reference };
    } catch (error) {
      return failed(error, reply, requestId);
    }
  });

  // Browser-safe settings for the hosted checkout script. Never a secret.
  app.get("/v1/billing/checkout/client", { config: rate }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    if (!provider.checkoutClient) {
      return reply.code(404).send({ code: "NOT_FOUND", message: "This deployment has no hosted checkout" });
    }
    return { provider: provider.name, environment: provider.checkoutClient.environment, token: provider.checkoutClient.token };
  });

  // ---- Customer portal: the caller's own processor customer, only ----
  app.post("/v1/billing/portal", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = await admit(req, reply);
    if (!user) return;
    const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    // Looked up by the session identity; the browser never names a customer.
    const row = await repo.getSubscription(user.id);
    if (!row || row.provider === "manual" || row.provider !== provider.name || !row.provider_customer_ref || !row.provider_ref) {
      return reply.code(404).send({ code: "NO_BILLING_ACCOUNT", message: "There is no payment processor account for this identity", requestId });
    }
    try {
      const session = await provider.createPortalSession({ customerRef: row.provider_customer_ref, subscriptionRef: row.provider_ref });
      logger.info("billing portal session created", { requestId, provider: provider.name });
      return { url: session.url };
    } catch (error) {
      return failed(error, reply, requestId);
    }
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
    // without collecting payment would be a lie in the ledger.
    if (!provider.supportsSelfServe) {
      return reply.code(501).send({
        code: "PAYMENT_PROVIDER_REQUIRED",
        message: "This deployment has no payment provider configured; paid plans are granted by an operator",
        requestId
      });
    }
    const current = await repo.getSubscription(user.id);
    if (!current || current.status === "EXPIRED") {
      return reply.code(409).send({ code: "CHECKOUT_REQUIRED", message: "A paid plan starts at checkout", requestId });
    }
    return reply.code(501).send({
      code: "NOT_SUPPORTED",
      message: "Plan changes are not self-serve yet; cancel at period end and subscribe to the new plan afterwards",
      requestId
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
    const action = req.body?.immediate === true ? "CANCEL_IMMEDIATELY" : "CANCEL";
    const current = await repo.getSubscription(user.id);
    const cancelView = (row: SubscriptionRow) => ({
      status: row.status,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      effectiveAt: row.current_period_end
    });
    if (current && current.provider !== "manual") {
      return viaProcessor(user.id, current, action, reply, requestId, cancelView);
    }
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
    const current = await repo.getSubscription(user.id);
    if (current && current.provider !== "manual") {
      return viaProcessor(user.id, current, "RESUME", reply, requestId, (row) => ({
        status: row.status,
        cancelAtPeriodEnd: row.cancel_at_period_end
      }));
    }
    try {
      const result = await act(user.id, "RESUME");
      logger.info("billing transition", { requestId, action: "RESUME", event: result.event.type, applied: result.applied });
      return { status: result.subscription.status, cancelAtPeriodEnd: result.subscription.cancelAtPeriodEnd };
    } catch (error) {
      return failed(error, reply, requestId);
    }
  });

  // ---- Processor webhooks ----
  const webhooks = provider.webhooks;
  if (webhooks) {
    void app.register(async (scope) => {
      // A signature covers the exact bytes sent, so inside this scope the
      // body stays the raw string instead of being parsed and re-serialized.
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit: config.BILLING_WEBHOOK_MAX_BYTES },
        (_req, body, done) => done(null, body)
      );
      scope.post(
        `/v1/billing/webhooks/${provider.name}`,
        { bodyLimit: config.BILLING_WEBHOOK_MAX_BYTES, config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
        (req, reply) => handleWebhook(req, reply, webhooks)
      );
    });
  }
}
