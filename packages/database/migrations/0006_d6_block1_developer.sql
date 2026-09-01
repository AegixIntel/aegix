-- D6 Block 1: saved comparisons (D6-A), developer API keys (D6-C),
-- developer usage metering (D6-D). See docs/d6-block1.md.

-- ---------------------------------------------------------------------------
-- Saved comparisons (D6-A): user-owned bookmarks referencing the shared,
-- cacheable comparison result. The intelligence payload (evidence, paths,
-- clusters) is NOT copied per user — the row stores the pair + optional
-- comparison result id for historical result reuse.
--
-- Idempotency: one saved comparison per (user_id, pair_key), mirroring the
-- saved_analyses (user_id, wallet_id) pattern. pair_key is the canonical
-- (sorted) pair; wallet_a/wallet_b keep the display orientation.
-- ---------------------------------------------------------------------------
create table if not exists saved_comparisons (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  pair_key text not null,
  wallet_a text not null,
  wallet_b text not null,
  comparison_result_id bigint references correlation_results (id) on delete set null,
  label text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_opened_at timestamptz,
  unique (user_id, pair_key)
);

create index if not exists idx_saved_comparisons_user on saved_comparisons (user_id, created_at desc);
create index if not exists idx_saved_comparisons_pair on saved_comparisons (pair_key);

-- ---------------------------------------------------------------------------
-- Developer API keys (D6-C): NEVER stores the plaintext key. key_hash is a
-- SHA-256 digest of the full key (high-entropy secret, no pepper needed, see
-- docs/d6-block1.md §hashing); key_prefix identifies the key for listing.
-- Status: ACTIVE | REVOKED. revoke is irreversible; rows are retained so
-- usage records keep their key attribution (FK on delete set null is not
-- used: the key row survives for audit).
-- ---------------------------------------------------------------------------
create table if not exists developer_api_keys (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null,
  scopes jsonb not null default '[]',
  status text not null default 'ACTIVE', -- ACTIVE | REVOKED
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_developer_api_keys_user on developer_api_keys (user_id, created_at desc);
create unique index if not exists idx_developer_api_keys_prefix on developer_api_keys (key_prefix) where status = 'ACTIVE';
-- Partial unique index for active keys: one plaintext prefix can only belong
-- to one live key. The plaintext key embeds a random 128-bit value, so the
-- prefix cannot be guessed (see docs/d6-block1.md §key-format).

-- ---------------------------------------------------------------------------
-- Developer usage metering (D6-D): event-level usage records, the same
-- pattern as usage_records (D3) but attributed to the developer key.
-- Quota is enforced per user (keys cannot multiply quota); the key column
-- provides attribution. request_id is the idempotency anchor so internal
-- retries never double-meter one request.
-- ---------------------------------------------------------------------------
create table if not exists developer_usage_events (
  id bigserial primary key,
  user_id uuid references profiles (id) on delete cascade,
  api_key_id bigint references developer_api_keys (id) on delete set null,
  operation text not null,
  request_id text not null,
  status text not null, -- SUCCESS | REJECTED
  units integer not null default 1,
  cache_hit boolean not null default false,
  created_work boolean not null default false,
  latency_ms integer,
  scope text,
  created_at timestamptz not null default now()
);

create index if not exists idx_developer_usage_user_period on developer_usage_events (user_id, created_at);
create index if not exists idx_developer_usage_key on developer_usage_events (api_key_id, created_at);
create unique index if not exists idx_developer_usage_request on developer_usage_events (request_id);

-- ---------------------------------------------------------------------------
-- Developer quota counters (D6-D §70): the atomic quota mechanism. One row
-- per (user_id, UTC day). Claims are an upsert that serializes on the
-- primary-key row lock, so concurrent requests can never exceed the limit:
--   insert ... select ... where units <= limit
--   on conflict (user_id, period_start) do update
--     set units = counters.units + excluded.units
--     where counters.units + excluded.units <= limit
--   returning units   -- empty when the claim would exceed the limit
-- developer_usage_events remains the audit trail; the counter is the
-- source of truth for used/remaining.
-- ---------------------------------------------------------------------------
create table if not exists developer_quota_counters (
  user_id uuid not null references profiles (id) on delete cascade,
  period_start timestamptz not null,
  units integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);

-- ---------------------------------------------------------------------------
-- RLS on user-owned D6 tables. The API uses the service role (bypasses RLS);
-- these policies scope direct client access, the exact pattern of
-- saved_analyses (0002) and the D4 tables (0003). Auth.uid() is stubbed to
-- NULL on local Postgres (0002), so unauthorized contexts match nothing.
-- ---------------------------------------------------------------------------
alter table saved_comparisons enable row level security;
alter table developer_api_keys enable row level security;
alter table developer_usage_events enable row level security;

create policy saved_comparisons_select_own on saved_comparisons
  for select using (user_id = auth.uid());
create policy saved_comparisons_insert_own on saved_comparisons
  for insert with check (user_id = auth.uid());
create policy saved_comparisons_update_own on saved_comparisons
  for update using (user_id = auth.uid());
create policy saved_comparisons_delete_own on saved_comparisons
  for delete using (user_id = auth.uid());

create policy developer_api_keys_select_own on developer_api_keys
  for select using (user_id = auth.uid());
create policy developer_api_keys_insert_own on developer_api_keys
  for insert with check (user_id = auth.uid());
create policy developer_api_keys_update_own on developer_api_keys
  for update using (user_id = auth.uid());
create policy developer_api_keys_delete_own on developer_api_keys
  for delete using (user_id = auth.uid());

create policy developer_usage_events_select_own on developer_usage_events
  for select using (user_id = auth.uid());
create policy developer_usage_events_insert_own on developer_usage_events
  for insert with check (user_id = auth.uid());

alter table developer_quota_counters enable row level security;
create policy developer_quota_counters_select_own on developer_quota_counters
  for select using (user_id = auth.uid());
