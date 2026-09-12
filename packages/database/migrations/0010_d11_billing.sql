-- D11: billing / entitlements.
-- See docs/milestone-d11.md and architecture.md §69 ("Keep billing
-- isolated"), §71 (RLS), §82 (plan-based limits).
--
-- Four new tables complete the set architecture.md §69 requires:
-- plans, subscriptions, billing_events, invoices. usage_records already
-- exists from 0001 and remains the metering source of truth — D11 reads it,
-- it does not replace it.
--
-- Nothing here changes behaviour on its own. An identity with no
-- subscription row resolves to the free plan, and the free plan is defined
-- as the deployment's existing limits, so applying this migration leaves
-- every D1-D10 quota exactly where it was.

-- ---------------------------------------------------------------------------
-- Plan catalog. The API is the source of truth for what is enforced (the
-- catalog is derived from AppConfig so limits stay tunable per deployment);
-- this table is the persisted snapshot of that catalog. It exists so
-- subscriptions have referential integrity, and so an operator can read the
-- shipped plan shape straight from the database. The API upserts it
-- idempotently the first time a billing route is served.
--
-- The seed below is the catalog produced by the documented default config.
-- A deployment that tunes its limits overwrites these rows on first use.
-- ---------------------------------------------------------------------------
create table if not exists plans (
  code text primary key,
  name text not null,
  tier integer not null,
  price_cents integer not null default 0,
  currency text not null default 'USD',
  billing_interval text not null default 'NONE', -- NONE | MONTH | YEAR
  entitlements jsonb not null default '{}',
  overage_cents jsonb not null default '{}',
  status text not null default 'ACTIVE',         -- ACTIVE | RETIRED
  catalog_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into plans (code, name, tier, price_cents, currency, billing_interval, entitlements, catalog_version)
values
  ('free', 'Free', 0, 0, 'USD', 'NONE', '{
     "analysis.daily": 10, "compare.daily": 50, "ask.daily": 25, "markets.daily": 200,
     "monitors.active": 3, "apiKeys.active": 10, "webhooks.active": 5,
     "api.daily": 500
   }', 'billing-catalog-v1.0.0'),
  ('pro', 'Pro', 1, 4900, 'USD', 'MONTH', '{
     "analysis.daily": 100, "compare.daily": 500, "ask.daily": 250, "markets.daily": 2000,
     "monitors.active": 15, "apiKeys.active": 50, "webhooks.active": 25,
     "api.daily": 5000
   }', 'billing-catalog-v1.0.0'),
  ('team', 'Team', 2, 19900, 'USD', 'MONTH', '{
     "analysis.daily": 400, "compare.daily": 2000, "ask.daily": 1000, "markets.daily": 8000,
     "monitors.active": 60, "apiKeys.active": 200, "webhooks.active": 100,
     "api.daily": 20000
   }', 'billing-catalog-v1.0.0')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Subscriptions: at most one row per identity. The row is the current state;
-- the full history is billing_events, which is append-only. Keeping current
-- state single-row means "which subscription applies right now" is never a
-- query with an ordering in it.
--
-- provider/provider_ref are the payment-processor seam. This baseline ships
-- the 'manual' provider only (architecture.md PR-12: the beta operates
-- without payment infrastructure), so provider_ref is null and no secret is
-- involved.
-- ---------------------------------------------------------------------------
create table if not exists subscriptions (
  id bigserial primary key,
  user_id uuid not null unique references profiles (id) on delete cascade,
  plan_code text not null references plans (code),
  status text not null, -- TRIALING | ACTIVE | PAST_DUE | CANCELED | EXPIRED
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  grace_period_end timestamptz,
  trial_end timestamptz,
  provider text not null default 'manual',
  provider_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The lifecycle job scans for subscriptions whose period or grace window has
-- elapsed; both bounds are covered so the scan never degrades to a seq scan.
create index if not exists idx_subscriptions_period_end
  on subscriptions (current_period_end)
  where status <> 'EXPIRED';
create index if not exists idx_subscriptions_grace_end
  on subscriptions (grace_period_end)
  where status = 'PAST_DUE';

-- ---------------------------------------------------------------------------
-- Billing events: the append-only audit ledger. Every state transition is
-- written here in the same transaction that mutates the subscription, so the
-- two can never disagree.
--
-- event_key is the idempotency anchor, exactly as request_id is for
-- developer_usage_events (D6-D §75): a retried lifecycle job or a redelivered
-- provider callback writes the same key and is absorbed by the unique index
-- instead of duplicating history.
-- ---------------------------------------------------------------------------
create table if not exists billing_events (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  subscription_id bigint references subscriptions (id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text not null,
  from_plan text,
  to_plan text not null,
  detail jsonb not null default '{}',
  event_key text not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists idx_billing_events_key on billing_events (event_key);
create index if not exists idx_billing_events_user on billing_events (user_id, occurred_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Invoices: one per identity per billing period. Lines are derived from the
-- plan and the metered usage for the period, so an invoice can be recomputed
-- and compared rather than trusted blindly.
--
-- No money moves in this baseline: invoices are raised DRAFT/OPEN and there
-- is no settlement path until a payment provider exists.
-- ---------------------------------------------------------------------------
create table if not exists invoices (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  subscription_id bigint references subscriptions (id) on delete set null,
  plan_code text not null,
  currency text not null default 'USD',
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'DRAFT', -- DRAFT | OPEN | PAID | VOID
  lines jsonb not null default '[]',
  subtotal_cents integer not null default 0,
  total_cents integer not null default 0,
  engine_version text not null,
  issued_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One invoice per identity per period: re-running invoice generation for a
-- period updates the existing row instead of raising a second bill.
create unique index if not exists idx_invoices_user_period on invoices (user_id, period_start);
create index if not exists idx_invoices_user_recent on invoices (user_id, period_start desc, id desc);

-- ---------------------------------------------------------------------------
-- Billing reads usage_records by (user, usage_type, day). The 0001 indexes
-- cover (user_id, created_at) only, so every metered-quota claim and every
-- period rollup filters usage_type after the index scan.
-- ---------------------------------------------------------------------------
create index if not exists idx_usage_user_type_day on usage_records (user_id, usage_type, created_at);

-- ---------------------------------------------------------------------------
-- RLS on the user-owned billing tables, the same pattern as the D6 tables
-- (0006). The API uses the service role and bypasses these; they scope
-- direct client access so an identity reads only its own subscription,
-- ledger and invoices (§71). auth.uid() is stubbed to NULL on local
-- Postgres (0002), so an unauthorized context matches no rows.
--
-- Writes are deliberately not granted to clients: billing state changes only
-- through the API, which owns the state machine. `plans` carries no RLS — it
-- is public reference data with no user column.
-- ---------------------------------------------------------------------------
alter table subscriptions enable row level security;
alter table billing_events enable row level security;
alter table invoices enable row level security;

create policy subscriptions_select_own on subscriptions
  for select using (user_id = auth.uid());
create policy billing_events_select_own on billing_events
  for select using (user_id = auth.uid());
create policy invoices_select_own on invoices
  for select using (user_id = auth.uid());
