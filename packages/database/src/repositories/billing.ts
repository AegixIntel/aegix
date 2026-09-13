import { createHash } from "node:crypto";
import type { JsonValue, Sql, SqlTransaction } from "../client.js";

/**
 * D11 billing persistence, see docs/milestone-d11.md.
 *
 * The repository owns storage only: no plan is priced here, no transition is
 * decided here. @aegix/billing computes the next state and the event that
 * describes it; this module writes both in one transaction so the
 * append-only ledger can never disagree with current state.
 */

export interface PlanRow {
  code: string;
  name: string;
  tier: number;
  price_cents: number;
  currency: string;
  billing_interval: string;
  entitlements: Record<string, number>;
  overage_cents: Record<string, number>;
  status: string;
  catalog_version: string;
}

export type SubscriptionStatusValue = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_code: string;
  status: SubscriptionStatusValue;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  grace_period_end: string | null;
  trial_end: string | null;
  provider: string;
  provider_ref: string | null;
  /** Processor customer that owns a processor-managed subscription. */
  provider_customer_ref: string | null;
  /** Newest processor observation applied; older ones are stale. */
  provider_observed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingEventRow {
  id: string;
  user_id: string;
  subscription_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string;
  from_plan: string | null;
  to_plan: string;
  detail: Record<string, unknown>;
  event_key: string;
  occurred_at: string;
}

export type InvoiceStatus = "DRAFT" | "OPEN" | "PAID" | "VOID";

export interface InvoiceRow {
  id: string;
  user_id: string;
  subscription_id: string | null;
  plan_code: string;
  currency: string;
  period_start: string;
  period_end: string;
  status: InvoiceStatus;
  lines: unknown;
  subtotal_cents: number;
  total_cents: number;
  engine_version: string;
  issued_at: string | null;
  paid_at: string | null;
}

export interface PlanSnapshot {
  code: string;
  name: string;
  tier: number;
  priceCents: number;
  currency: string;
  interval: string;
  entitlements: Record<string, number>;
  overageCents: Record<string, number>;
  status: string;
  catalogVersion: string;
}

export interface SubscriptionWrite {
  planCode: string;
  status: SubscriptionStatusValue;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  gracePeriodEnd: string | null;
  trialEnd: string | null;
  provider: string;
  providerRef: string | null;
}

export interface BillingEventWrite {
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  fromPlan: string | null;
  toPlan: string;
  detail: Record<string, unknown>;
  /** Idempotency anchor: a replayed transition is absorbed, not duplicated. */
  eventKey: string;
  occurredAt: string;
}

export interface ApplyTransitionInput {
  userId: string;
  subscription: SubscriptionWrite;
  event: BillingEventWrite;
  /** Denormalized label written back to profiles.plan for legacy readers. */
  profilePlan: string;
}

export interface ApplyTransitionResult {
  subscription: SubscriptionRow | null;
  /**
   * False when this exact event had already been recorded. The caller's
   * transition was a replay and nothing was mutated.
   */
  applied: boolean;
}

export interface ProviderSubscriptionWrite extends SubscriptionWrite {
  providerRef: string;
  providerCustomerRef: string | null;
  providerObservedAt: string;
}

export interface ProviderSyncWrite {
  subscription: ProviderSubscriptionWrite;
  event: BillingEventWrite;
  profilePlan: string;
}

/** What a processor sync decided, given the locked current row. */
export interface ProviderSyncStep<T> {
  decision: T;
  /** State and ledger entry to write; null when state does not change. */
  write: ProviderSyncWrite | null;
  /**
   * A newer processor observation to record when state does not change, so
   * a later-arriving snapshot from in between is still recognised as stale.
   */
  observedAt: string | null;
}

export interface ProviderSyncResult<T> {
  decision: T;
  applied: boolean;
  subscription: SubscriptionRow | null;
}

export interface CheckoutWrite {
  userId: string;
  provider: string;
  checkoutRef: string;
  /** Plain token; only its hash is stored. */
  token: string;
  planCode: string;
}

export interface CheckoutRow {
  id: string;
  user_id: string;
  provider: string;
  checkout_ref: string;
  plan_code: string;
  created_at: string;
}

export type ProviderEventOutcome = "APPLIED" | "UNCHANGED" | "STALE" | "DUPLICATE" | "IGNORED";

export interface ProviderEventWrite {
  provider: string;
  eventId: string;
  eventType: string;
  occurredAt: string;
  outcome: ProviderEventOutcome;
  reason: string | null;
  userId: string | null;
  subscriptionRef: string | null;
}

export interface UsageTotal {
  usage_type: string;
  units: number;
}

export interface InvoiceWrite {
  userId: string;
  subscriptionId: string | null;
  planCode: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  status: InvoiceStatus;
  lines: JsonValue;
  subtotalCents: number;
  totalCents: number;
  engineVersion: string;
}

export interface BillingRepo {
  /** Idempotent upsert of the in-process plan catalog snapshot. */
  syncPlans(plans: readonly PlanSnapshot[]): Promise<void>;
  listPlans(): Promise<PlanRow[]>;
  getSubscription(userId: string): Promise<SubscriptionRow | null>;
  /** Writes state and ledger entry together, or neither. */
  applyTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult>;
  /**
   * Applies processor-reported state. `decide` runs inside the transaction
   * against the identity's locked current row, so concurrent deliveries for
   * one identity are serialized and each decides against the state the one
   * before it wrote.
   */
  applyProviderSync<T>(userId: string, decide: (current: SubscriptionRow | null) => ProviderSyncStep<T>): Promise<ProviderSyncResult<T>>;
  /** The identity a processor subscription is already bound to. */
  findSubscriberByProviderRef(provider: string, subscriptionRef: string): Promise<string | null>;
  recordCheckout(input: CheckoutWrite): Promise<void>;
  findCheckoutByRef(provider: string, checkoutRef: string): Promise<CheckoutRow | null>;
  findCheckoutByToken(provider: string, token: string): Promise<CheckoutRow | null>;
  /** Whether this processor event has already been handled. */
  hasProviderEvent(provider: string, eventId: string): Promise<boolean>;
  /** Records a handled event once; false when it was already recorded. */
  recordProviderEvent(input: ProviderEventWrite): Promise<boolean>;
  listEvents(userId: string, limit: number): Promise<BillingEventRow[]>;
  /**
   * Manual subscriptions whose period, grace window or trial has elapsed.
   * Processor-managed subscriptions are moved by their processor, never by
   * the sweep: renewing one here would grant a period nobody paid for.
   */
  dueForLifecycle(now: Date, limit: number): Promise<SubscriptionRow[]>;
  /** usage_records totals per usage_type for a half-open period. */
  usageForPeriod(userId: string, periodStart: string, periodEnd: string): Promise<UsageTotal[]>;
  /** Successful developer API units for a half-open period (D6-D). */
  developerUnitsForPeriod(userId: string, periodStart: string, periodEnd: string): Promise<number>;
  /** One invoice per identity per period; re-running updates in place. */
  upsertInvoice(input: InvoiceWrite): Promise<InvoiceRow>;
  listInvoices(userId: string, limit: number): Promise<InvoiceRow[]>;
  getInvoice(userId: string, id: string): Promise<InvoiceRow | null>;
}

/**
 * postgres.js returns `timestamptz` as a Date. Every consumer of these rows
 * compares instants as ISO strings, and `Date.parse(someDate)` is NaN, so
 * timestamps are normalized once here rather than defensively everywhere.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  return String(value);
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function normalizeSubscription(row: SubscriptionRow | undefined): SubscriptionRow | null {
  if (!row) return null;
  return {
    ...row,
    current_period_start: toIso(row.current_period_start),
    current_period_end: toIso(row.current_period_end),
    grace_period_end: toIsoOrNull(row.grace_period_end),
    trial_end: toIsoOrNull(row.trial_end),
    provider_observed_at: toIsoOrNull(row.provider_observed_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at)
  };
}

function normalizeInvoice(row: InvoiceRow): InvoiceRow {
  return {
    ...row,
    period_start: toIso(row.period_start),
    period_end: toIso(row.period_end),
    issued_at: toIsoOrNull(row.issued_at),
    paid_at: toIsoOrNull(row.paid_at)
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function selectSubscription(sql: Sql | SqlTransaction, userId: string): Promise<SubscriptionRow | null> {
  const [row] = await sql<SubscriptionRow[]>`
    select id::text, user_id::text, plan_code, status, current_period_start,
           current_period_end, cancel_at_period_end, grace_period_end, trial_end,
           provider, provider_ref, provider_customer_ref, provider_observed_at,
           created_at, updated_at
    from subscriptions
    where user_id = ${userId}
    limit 1
  `;
  return normalizeSubscription(row);
}

/**
 * Serializes every billing write for one identity. The manual state machine,
 * processor webhooks and processor API responses can all target the same
 * subscription; each must decide against the state the previous one wrote.
 */
async function lockIdentity(tx: SqlTransaction, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${`aegix:billing:${userId}`}))`;
}

async function selectCheckout(sql: Sql, where: { provider: string; checkoutRef?: string; tokenHash?: string }): Promise<CheckoutRow | null> {
  const [row] = where.checkoutRef !== undefined
    ? await sql<CheckoutRow[]>`
        select id::text, user_id::text, provider, checkout_ref, plan_code, created_at
        from billing_checkouts
        where provider = ${where.provider} and checkout_ref = ${where.checkoutRef}
        limit 1
      `
    : await sql<CheckoutRow[]>`
        select id::text, user_id::text, provider, checkout_ref, plan_code, created_at
        from billing_checkouts
        where provider = ${where.provider} and token_hash = ${where.tokenHash ?? ""}
        limit 1
      `;
  return row ? { ...row, created_at: toIso(row.created_at) } : null;
}

export function createBillingRepo(sql: Sql): BillingRepo {
  return {
    async syncPlans(plans) {
      if (plans.length === 0) return;
      await sql.begin(async (tx) => {
        for (const plan of plans) {
          await tx`
            insert into plans (
              code, name, tier, price_cents, currency, billing_interval,
              entitlements, overage_cents, status, catalog_version, updated_at
            ) values (
              ${plan.code}, ${plan.name}, ${plan.tier}, ${plan.priceCents}, ${plan.currency}, ${plan.interval},
              ${tx.json(plan.entitlements as unknown as JsonValue)},
              ${tx.json(plan.overageCents as unknown as JsonValue)},
              ${plan.status}, ${plan.catalogVersion}, now()
            )
            on conflict (code) do update set
              name = excluded.name,
              tier = excluded.tier,
              price_cents = excluded.price_cents,
              currency = excluded.currency,
              billing_interval = excluded.billing_interval,
              entitlements = excluded.entitlements,
              overage_cents = excluded.overage_cents,
              status = excluded.status,
              catalog_version = excluded.catalog_version,
              updated_at = now()
          `;
        }
      });
    },

    async listPlans() {
      return sql<PlanRow[]>`
        select code, name, tier, price_cents, currency, billing_interval,
               entitlements, overage_cents, status, catalog_version
        from plans
        order by tier asc
      `;
    },

    async getSubscription(userId) {
      return selectSubscription(sql, userId);
    },

    async applyTransition(input) {
      return sql.begin(async (tx) => {
        await lockIdentity(tx, input.userId);
        // The ledger entry is claimed first: if this exact event has already
        // been recorded the transition is a replay, and nothing is mutated.
        // Claiming after the state write would let a retried RENEW advance
        // the billing period twice.
        const [claim] = await tx<Array<{ id: string }>>`
          insert into billing_events (
            user_id, event_type, from_status, to_status, from_plan, to_plan,
            detail, event_key, occurred_at
          ) values (
            ${input.userId}, ${input.event.eventType}, ${input.event.fromStatus},
            ${input.event.toStatus}, ${input.event.fromPlan}, ${input.event.toPlan},
            ${tx.json(input.event.detail as JsonValue)}, ${input.event.eventKey},
            ${input.event.occurredAt}::timestamptz
          )
          on conflict (event_key) do nothing
          returning id::text
        `;
        if (!claim) {
          return { subscription: await selectSubscription(tx, input.userId), applied: false };
        }

        const sub = input.subscription;
        // A manual write owns the row outright: any processor binding it
        // replaces (an operator override) is cleared with it.
        const [row] = await tx<SubscriptionRow[]>`
          insert into subscriptions (
            user_id, plan_code, status, current_period_start, current_period_end,
            cancel_at_period_end, grace_period_end, trial_end, provider, provider_ref
          ) values (
            ${input.userId}, ${sub.planCode}, ${sub.status},
            ${sub.currentPeriodStart}::timestamptz, ${sub.currentPeriodEnd}::timestamptz,
            ${sub.cancelAtPeriodEnd}, ${sub.gracePeriodEnd}, ${sub.trialEnd},
            ${sub.provider}, ${sub.providerRef}
          )
          on conflict (user_id) do update set
            plan_code = excluded.plan_code,
            status = excluded.status,
            current_period_start = excluded.current_period_start,
            current_period_end = excluded.current_period_end,
            cancel_at_period_end = excluded.cancel_at_period_end,
            grace_period_end = excluded.grace_period_end,
            trial_end = excluded.trial_end,
            provider = excluded.provider,
            provider_ref = excluded.provider_ref,
            provider_customer_ref = null,
            provider_observed_at = null,
            updated_at = now()
          returning id::text, user_id::text, plan_code, status, current_period_start,
                    current_period_end, cancel_at_period_end, grace_period_end, trial_end,
                    provider, provider_ref, provider_customer_ref, provider_observed_at,
                    created_at, updated_at
        `;
        if (!row) throw new Error("subscription upsert returned no row");

        await tx`update billing_events set subscription_id = ${row.id} where id = ${claim.id}`;
        // profiles.plan predates D11 and is still read as a coarse label;
        // keeping it in the same transaction stops it drifting from the
        // subscription it describes.
        await tx`update profiles set plan = ${input.profilePlan}, updated_at = now() where id = ${input.userId}`;

        return { subscription: normalizeSubscription(row), applied: true };
      });
    },

    async applyProviderSync<T>(userId: string, decide: (current: SubscriptionRow | null) => ProviderSyncStep<T>) {
      const result = await sql.begin(async (tx) => {
        await lockIdentity(tx, userId);
        const current = await selectSubscription(tx, userId);
        const step = decide(current);

        if (!step.write) {
          if (step.observedAt && current) {
            await tx`
              update subscriptions
              set provider_observed_at = greatest(coalesce(provider_observed_at, ${step.observedAt}::timestamptz), ${step.observedAt}::timestamptz)
              where user_id = ${userId}
            `;
          }
          return { decision: step.decision, applied: false, subscription: current };
        }

        const { subscription: sub, event, profilePlan } = step.write;
        const [claim] = await tx<Array<{ id: string }>>`
          insert into billing_events (
            user_id, event_type, from_status, to_status, from_plan, to_plan,
            detail, event_key, occurred_at
          ) values (
            ${userId}, ${event.eventType}, ${event.fromStatus}, ${event.toStatus},
            ${event.fromPlan}, ${event.toPlan}, ${tx.json(event.detail as JsonValue)},
            ${event.eventKey}, ${event.occurredAt}::timestamptz
          )
          on conflict (event_key) do nothing
          returning id::text
        `;
        if (!claim) return { decision: step.decision, applied: false, subscription: current };

        const [row] = await tx<SubscriptionRow[]>`
          insert into subscriptions (
            user_id, plan_code, status, current_period_start, current_period_end,
            cancel_at_period_end, grace_period_end, trial_end, provider, provider_ref,
            provider_customer_ref, provider_observed_at
          ) values (
            ${userId}, ${sub.planCode}, ${sub.status},
            ${sub.currentPeriodStart}::timestamptz, ${sub.currentPeriodEnd}::timestamptz,
            ${sub.cancelAtPeriodEnd}, ${sub.gracePeriodEnd}, ${sub.trialEnd},
            ${sub.provider}, ${sub.providerRef}, ${sub.providerCustomerRef},
            ${sub.providerObservedAt}::timestamptz
          )
          on conflict (user_id) do update set
            plan_code = excluded.plan_code,
            status = excluded.status,
            current_period_start = excluded.current_period_start,
            current_period_end = excluded.current_period_end,
            cancel_at_period_end = excluded.cancel_at_period_end,
            grace_period_end = excluded.grace_period_end,
            trial_end = excluded.trial_end,
            provider = excluded.provider,
            provider_ref = excluded.provider_ref,
            provider_customer_ref = excluded.provider_customer_ref,
            provider_observed_at = excluded.provider_observed_at,
            updated_at = now()
          returning id::text, user_id::text, plan_code, status, current_period_start,
                    current_period_end, cancel_at_period_end, grace_period_end, trial_end,
                    provider, provider_ref, provider_customer_ref, provider_observed_at,
                    created_at, updated_at
        `;
        if (!row) throw new Error("subscription upsert returned no row");

        await tx`update billing_events set subscription_id = ${row.id} where id = ${claim.id}`;
        await tx`update profiles set plan = ${profilePlan}, updated_at = now() where id = ${userId}`;
        return { decision: step.decision, applied: true, subscription: normalizeSubscription(row) };
      });
      return result as ProviderSyncResult<T>;
    },

    async findSubscriberByProviderRef(provider, subscriptionRef) {
      const [row] = await sql<Array<{ user_id: string }>>`
        select user_id::text from subscriptions
        where provider = ${provider} and provider_ref = ${subscriptionRef}
        limit 1
      `;
      return row?.user_id ?? null;
    },

    async recordCheckout(input) {
      await sql`
        insert into billing_checkouts (user_id, provider, checkout_ref, token_hash, plan_code)
        values (${input.userId}, ${input.provider}, ${input.checkoutRef}, ${hashToken(input.token)}, ${input.planCode})
        on conflict (provider, checkout_ref) do nothing
      `;
    },

    async findCheckoutByRef(provider, checkoutRef) {
      return selectCheckout(sql, { provider, checkoutRef });
    },

    async findCheckoutByToken(provider, token) {
      return selectCheckout(sql, { provider, tokenHash: hashToken(token) });
    },

    async hasProviderEvent(provider, eventId) {
      const [row] = await sql<Array<{ id: string }>>`
        select id::text from billing_provider_events
        where provider = ${provider} and event_id = ${eventId}
        limit 1
      `;
      return row !== undefined;
    },

    async recordProviderEvent(input) {
      const rows = await sql<Array<{ id: string }>>`
        insert into billing_provider_events (
          provider, event_id, event_type, occurred_at, outcome, reason, user_id, subscription_ref
        ) values (
          ${input.provider}, ${input.eventId}, ${input.eventType}, ${input.occurredAt}::timestamptz,
          ${input.outcome}, ${input.reason}, ${input.userId}, ${input.subscriptionRef}
        )
        on conflict (provider, event_id) do nothing
        returning id::text
      `;
      return rows.length > 0;
    },

    async listEvents(userId, limit) {
      const rows = await sql<BillingEventRow[]>`
        select id::text, user_id::text, subscription_id::text, event_type, from_status,
               to_status, from_plan, to_plan, detail, event_key, occurred_at
        from billing_events
        where user_id = ${userId}
        order by occurred_at desc, id desc
        limit ${limit}
      `;
      return rows.map((row) => ({ ...row, occurred_at: toIso(row.occurred_at) }));
    },

    async dueForLifecycle(now, limit) {
      const at = now.toISOString();
      const rows = await sql<SubscriptionRow[]>`
        select id::text, user_id::text, plan_code, status, current_period_start,
               current_period_end, cancel_at_period_end, grace_period_end, trial_end,
               provider, provider_ref, provider_customer_ref, provider_observed_at,
               created_at, updated_at
        from subscriptions
        where status <> 'EXPIRED'
          and provider = 'manual'
          and (
            current_period_end <= ${at}::timestamptz
            or (status = 'PAST_DUE' and grace_period_end is not null and grace_period_end <= ${at}::timestamptz)
            or (status = 'TRIALING' and trial_end is not null and trial_end <= ${at}::timestamptz)
          )
        order by current_period_end asc
        limit ${limit}
      `;
      return rows.map((row) => normalizeSubscription(row)).filter((row): row is SubscriptionRow => row !== null);
    },

    async usageForPeriod(userId, periodStart, periodEnd) {
      const rows = await sql<Array<{ usage_type: string; units: string }>>`
        select usage_type, count(*)::text as units
        from usage_records
        where user_id = ${userId}
          and created_at >= ${periodStart}::timestamptz
          and created_at < ${periodEnd}::timestamptz
        group by usage_type
        order by usage_type asc
      `;
      return rows.map((row) => ({ usage_type: row.usage_type, units: Number(row.units) }));
    },

    async developerUnitsForPeriod(userId, periodStart, periodEnd) {
      const [row] = await sql<Array<{ units: string }>>`
        select coalesce(sum(units), 0)::text as units
        from developer_usage_events
        where user_id = ${userId}
          and status = 'SUCCESS'
          and created_at >= ${periodStart}::timestamptz
          and created_at < ${periodEnd}::timestamptz
      `;
      return row ? Number(row.units) : 0;
    },

    async upsertInvoice(input) {
      const [row] = await sql<InvoiceRow[]>`
        insert into invoices (
          user_id, subscription_id, plan_code, currency, period_start, period_end,
          status, lines, subtotal_cents, total_cents, engine_version, issued_at
        ) values (
          ${input.userId}, ${input.subscriptionId}, ${input.planCode}, ${input.currency},
          ${input.periodStart}::timestamptz, ${input.periodEnd}::timestamptz,
          ${input.status}, ${sql.json(input.lines)}, ${input.subtotalCents},
          ${input.totalCents}, ${input.engineVersion},
          ${input.status === "DRAFT" ? null : new Date().toISOString()}
        )
        on conflict (user_id, period_start) do update set
          subscription_id = excluded.subscription_id,
          plan_code = excluded.plan_code,
          currency = excluded.currency,
          period_end = excluded.period_end,
          status = excluded.status,
          lines = excluded.lines,
          subtotal_cents = excluded.subtotal_cents,
          total_cents = excluded.total_cents,
          engine_version = excluded.engine_version,
          issued_at = coalesce(invoices.issued_at, excluded.issued_at),
          updated_at = now()
        returning id::text, user_id::text, subscription_id::text, plan_code, currency,
                  period_start, period_end, status, lines, subtotal_cents, total_cents,
                  engine_version, issued_at, paid_at
      `;
      if (!row) throw new Error("invoice upsert returned no row");
      return normalizeInvoice(row);
    },

    async listInvoices(userId, limit) {
      const rows = await sql<InvoiceRow[]>`
        select id::text, user_id::text, subscription_id::text, plan_code, currency,
               period_start, period_end, status, lines, subtotal_cents, total_cents,
               engine_version, issued_at, paid_at
        from invoices
        where user_id = ${userId}
        order by period_start desc, id desc
        limit ${limit}
      `;
      return rows.map(normalizeInvoice);
    },

    async getInvoice(userId, id) {
      const [row] = await sql<InvoiceRow[]>`
        select id::text, user_id::text, subscription_id::text, plan_code, currency,
               period_start, period_end, status, lines, subtotal_cents, total_cents,
               engine_version, issued_at, paid_at
        from invoices
        where user_id = ${userId} and id = ${id}
        limit 1
      `;
      return row ? normalizeInvoice(row) : null;
    }
  };
}
