-- D3: public beta — admission control + saved analyses.
-- See docs/milestone-d3.md (D3-C, D3-G).

-- Supabase compatibility: the auth schema and auth.uid() exist on Supabase
-- managed Postgres. For local/vanilla Postgres we create a stub that always
-- returns NULL so RLS policies below default to deny (no rows match).
create schema if not exists auth;
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select null::uuid $$;

-- Track originating IP for anonymous pending limits and abuse protection.
alter table analysis_jobs add column if not exists ip_address text;

-- Saved analyses: user-owned bookmarks pointing at shared analysis reports.
-- The report itself is public blockchain data; only the bookmark is private.
create table if not exists saved_analyses (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  analysis_id uuid references analysis_jobs (id) on delete set null,
  label text,
  created_at timestamptz not null default now()
);

create index if not exists idx_saved_analyses_user on saved_analyses (user_id, created_at desc);
create unique index if not exists idx_saved_analyses_user_wallet on saved_analyses (user_id, wallet_id);

-- Enable row level security on user-owned data. The API uses the Supabase
-- service role (bypasses RLS); direct client access is scoped by policies.
alter table saved_analyses enable row level security;

create policy saved_analyses_select_own on saved_analyses
  for select using (user_id = auth.uid());
create policy saved_analyses_insert_own on saved_analyses
  for insert with check (user_id = auth.uid());
create policy saved_analyses_delete_own on saved_analyses
  for delete using (user_id = auth.uid());
