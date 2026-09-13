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

export type UpgradeRequestStatus = "OPEN" | "FULFILLED";

export interface UpgradeRequestRow {
  id: string;
  user_id: string;
  plan_code: string;
  status: UpgradeRequestStatus;
  contact: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface BillingRepo {
  /**
   * Records the identity's request for a paid plan, or re-targets its open
   * one. Intent only: no subscription or ledger entry is touched.
   */
  requestUpgrade(userId: string, planCode: string, contact: string | null): Promise<UpgradeRequestRow>;
  getOpenUpgradeRequest(userId: string): Promise<UpgradeRequestRow | null>;
  listOpenUpgradeRequests(limit: number): Promise<UpgradeRequestRow[]>;
  /** Closes the identity's open request once an operator has granted a plan. */
  fulfillUpgradeRequest(userId: string): Promise<number>;
  /** Idempotent upsert of the in-process plan catalog snapshot. */
  syncPlans(plans: readonly PlanSnapshot[]): Promise<void>;
  listPlans(): Promise<PlanRow[]>;
  getSubscription(userId: string): Promise<SubscriptionRow | null>;
  /** Writes state and ledger entry together, or neither. */
  applyTransition(input: ApplyTransitionInput): Promise<ApplyTransitionResult>;
  listEvents(userId: string, limit: number): Promise<BillingEventRow[]>;
  /** Subscriptions whose period, grace window or trial has elapsed. */
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

async function selectSubscription(sql: Sql | SqlTransaction, userId: string): Promise<SubscriptionRow | null> {
  const [row] = await sql<SubscriptionRow[]>`
    select id::text, user_id::text, plan_code, status, current_period_start,
           current_period_end, cancel_at_period_end, grace_period_end, trial_end,
           provider, provider_ref, created_at, updated_at
    from subscriptions
    where user_id = ${userId}
    limit 1
  `;
  return normalizeSubscription(row);
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
            updated_at = now()
          returning id::text, user_id::text, plan_code, status, current_period_start,
                    current_period_end, cancel_at_period_end, grace_period_end, trial_end,
                    provider, provider_ref, created_at, updated_at
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
               provider, provider_ref, created_at, updated_at
        from subscriptions
        where status <> 'EXPIRED'
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
    },

    async requestUpgrade(userId, planCode, contact) {
      const [row] = await sql<UpgradeRequestRow[]>`
        insert into billing_upgrade_requests (user_id, plan_code, contact)
        values (${userId}, ${planCode}, ${contact})
        on conflict (user_id) where status = 'OPEN' do update set
          plan_code = excluded.plan_code,
          contact = coalesce(excluded.contact, billing_upgrade_requests.contact),
          updated_at = now()
        returning id::text, user_id::text, plan_code, status, contact, created_at, updated_at, resolved_at
      `;
      if (!row) throw new Error("upgrade request upsert returned no row");
      return normalizeUpgradeRequest(row);
    },

    async getOpenUpgradeRequest(userId) {
      const [row] = await sql<UpgradeRequestRow[]>`
        select id::text, user_id::text, plan_code, status, contact, created_at, updated_at, resolved_at
        from billing_upgrade_requests
        where user_id = ${userId} and status = 'OPEN'
        limit 1
      `;
      return row ? normalizeUpgradeRequest(row) : null;
    },

    async listOpenUpgradeRequests(limit) {
      const rows = await sql<UpgradeRequestRow[]>`
        select id::text, user_id::text, plan_code, status, contact, created_at, updated_at, resolved_at
        from billing_upgrade_requests
        where status = 'OPEN'
        order by created_at asc, id asc
        limit ${limit}
      `;
      return rows.map(normalizeUpgradeRequest);
    },

    async fulfillUpgradeRequest(userId) {
      const rows = await sql`
        update billing_upgrade_requests
        set status = 'FULFILLED', resolved_at = now(), updated_at = now()
        where user_id = ${userId} and status = 'OPEN'
        returning id
      `;
      return rows.length;
    }
  };
}

function normalizeUpgradeRequest(row: UpgradeRequestRow): UpgradeRequestRow {
  return {
    ...row,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    resolved_at: toIsoOrNull(row.resolved_at)
  };
}
