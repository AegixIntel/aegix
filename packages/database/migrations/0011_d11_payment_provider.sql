-- D11: payment processor integration.
-- See docs/milestone-d11.md §6.
--
-- The manual provider keeps working exactly as before: every column added
-- here is nullable, and a row written by an operator grant leaves them null.

-- Which processor customer owns a processor-managed subscription, and the
-- newest processor observation applied to it. Processor callbacks arrive at
-- least once and in any order; a state observed before provider_observed_at
-- is never applied.
alter table subscriptions add column if not exists provider_customer_ref text;
alter table subscriptions add column if not exists provider_observed_at timestamptz;

-- A processor subscription belongs to exactly one identity.
create unique index if not exists idx_subscriptions_provider_ref
  on subscriptions (provider, provider_ref)
  where provider_ref is not null;

-- ---------------------------------------------------------------------------
-- Checkouts the API started. A processor subscription is bound to an identity
-- only through a checkout recorded here — by the processor's checkout
-- reference, or by the unguessable token the API handed the processor — never
-- by anything the browser claims. The token is stored as a SHA-256 hash.
-- ---------------------------------------------------------------------------
create table if not exists billing_checkouts (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  provider text not null,
  checkout_ref text not null,
  token_hash text not null,
  plan_code text not null references plans (code),
  created_at timestamptz not null default now()
);

create unique index if not exists idx_billing_checkouts_ref on billing_checkouts (provider, checkout_ref);
create unique index if not exists idx_billing_checkouts_token on billing_checkouts (provider, token_hash);
create index if not exists idx_billing_checkouts_user on billing_checkouts (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Every authenticated processor event, recorded once. (provider, event_id) is
-- the replay anchor: a redelivered or replayed event finds its row and changes
-- nothing. Only identifiers and the outcome are kept — never the payload,
-- which carries customer contact details.
-- ---------------------------------------------------------------------------
create table if not exists billing_provider_events (
  id bigserial primary key,
  provider text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  outcome text not null, -- APPLIED | UNCHANGED | STALE | DUPLICATE | IGNORED
  reason text,
  user_id uuid references profiles (id) on delete set null,
  subscription_ref text
);

create unique index if not exists idx_billing_provider_events_id on billing_provider_events (provider, event_id);
create index if not exists idx_billing_provider_events_user on billing_provider_events (user_id, received_at desc);

-- Processor bookkeeping is server-only: RLS on, and no client policy.
alter table billing_checkouts enable row level security;
alter table billing_provider_events enable row level security;
