-- D11 V1: manual subscription provisioning.
-- See docs/milestone-d11.md §6.
--
-- V1 has no self-service payment processor. A signed-in identity can ask for
-- a paid plan; an operator arranges payment and grants the plan with
-- `pnpm billing:grant`. A request records intent only: it never creates or
-- changes a subscription, and it writes nothing to the billing ledger.

create table if not exists billing_upgrade_requests (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  plan_code text not null references plans (code),
  status text not null default 'OPEN', -- OPEN | FULFILLED
  -- Optional, user-supplied: wallet-only identities have no email on file,
  -- so this is how the operator reaches them to arrange payment.
  contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- At most one open request per identity; asking again re-targets it.
create unique index if not exists idx_billing_upgrade_requests_open
  on billing_upgrade_requests (user_id)
  where status = 'OPEN';
create index if not exists idx_billing_upgrade_requests_status
  on billing_upgrade_requests (status, created_at);

alter table billing_upgrade_requests enable row level security;
create policy billing_upgrade_requests_select_own on billing_upgrade_requests
  for select using (user_id = auth.uid());
