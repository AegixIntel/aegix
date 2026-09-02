-- D6 Block 2: wallet-only authentication (D6-P), population commonality
-- index (D6-G), monitor-driven correlation alerts (D6-F), webhooks (D6-H).
-- See docs/d6-block2.md.

-- ---------------------------------------------------------------------------
-- D6-P: wallet identity. The product user is the profile (stable internal
-- UUID); the wallet is the credential. profiles.primary_wallet is the login
-- wallet (unique when set). user_wallet_identities tracks verified wallet
-- bindings (future multi-wallet). RLS scoped to auth.uid() like 0003/0006.
-- ---------------------------------------------------------------------------
alter table profiles add column if not exists primary_wallet text;
create unique index if not exists idx_profiles_primary_wallet
  on profiles (primary_wallet) where primary_wallet is not null;

create table if not exists user_wallet_identities (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  wallet_address text not null,
  is_primary boolean not null default false,
  first_verified_at timestamptz not null default now(),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, wallet_address)
);

create index if not exists idx_user_wallet_identities_wallet on user_wallet_identities (wallet_address);

-- ---------------------------------------------------------------------------
-- D6-P: challenge-response auth. Only the SHA-256 digest of the nonce is
-- stored (a DB compromise must not expose usable challenges, D6-P §14).
-- Single use: consumed_at guard; atomic consumption is done in the verify
-- route (update ... where consumed_at is null returning). Short TTL.
-- ---------------------------------------------------------------------------
create table if not exists wallet_auth_challenges (
  id bigserial primary key,
  wallet_address text not null,
  nonce_hash text not null,
  domain text not null,
  uri text not null,
  statement text not null,
  version text not null default 'aegix-wallet-auth-v1',
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  request_ip_hash text,
  created_at timestamptz not null default now()
);

-- UNIQUE INDEX (not table constraint): the repo upserts on the nonce
-- (on conflict (wallet_address, nonce_hash)) and a bare unique index is
-- what PostgreSQL accepts for that clause.
create unique index if not exists wallet_auth_challenges_wallet_address_nonce_hash_key
  on wallet_auth_challenges (wallet_address, nonce_hash);

create index if not exists idx_wallet_auth_challenges_expiry
  on wallet_auth_challenges (expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- D6-P: server-issued sessions. The client holds a random 32-byte token;
-- only its SHA-256 digest is stored. Revocation is real (revoked_at).
-- ---------------------------------------------------------------------------
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists idx_sessions_user on sessions (user_id);

-- ---------------------------------------------------------------------------
-- D6-G: population commonality. Bounded aggregates over the AEGIX-analyzed
-- population (NOT the full Solana blockchain — see docs/d6-block2.md §78).
-- distinct_wallets = number of distinct analyzed wallets that observed the
-- key (a single hyperactive wallet must not make something common, §83).
-- population_contribution_state is the idempotency anchor: one contribution
-- per (wallet, version); re-analysis replaces the wallet's contribution
-- (snapshot semantics) so counts never double (§93-§95).
-- ---------------------------------------------------------------------------
create table if not exists population_observation_stats (
  id bigserial primary key,
  observation_type text not null, -- COUNTERPARTY | ENTITY | PROGRAM | MINT
  observation_key text not null,
  distinct_wallets integer not null default 0,
  observation_count integer not null default 0,
  population_size integer not null default 0,
  frequency numeric not null default 0,
  version text not null,
  updated_at timestamptz not null default now(),
  unique (observation_type, observation_key, version)
);

create index if not exists idx_population_stats_type on population_observation_stats (observation_type, observation_key);

create table if not exists population_contribution_state (
  wallet_id bigint primary key references wallets (id) on delete cascade,
  analysis_id uuid not null,
  version text not null,
  observation_keys jsonb not null default '[]',
  contributed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- D6-F: monitor-driven correlation alerts. Baselines persist the correlation
-- snapshot per (monitor, canonical pair) so change detection compares
-- previous vs current persisted state (§70). Correlation threat events are
-- fingerprint-deduped like D4 threat_events (cooldown anchor, §72-§73).
-- ---------------------------------------------------------------------------
create table if not exists monitor_correlation_baselines (
  id bigserial primary key,
  monitor_id bigint not null references privacy_monitors (id) on delete cascade,
  wallet_a text not null,
  wallet_b text not null,
  correlation_score integer not null,
  confidence numeric not null,
  classification text not null,
  correlation_result_id bigint references correlation_results (id) on delete set null,
  evidence_families jsonb not null default '[]',
  engine_version text not null,
  created_at timestamptz not null default now(),
  unique (monitor_id, wallet_a, wallet_b)
);

create table if not exists correlation_threat_events (
  id bigserial primary key,
  monitor_id bigint not null references privacy_monitors (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  related_wallet text not null,
  event_type text not null, -- CORRELATION_APPEARED|INCREASED|DECREASED|DISAPPEARED|NEW_STRONG_FUNDING_RELATIONSHIP|NEW_CLUSTER_MEMBERSHIP
  severity text not null,
  confidence numeric not null,
  previous_score integer,
  new_score integer,
  previous_confidence numeric,
  new_confidence numeric,
  evidence jsonb not null default '{}',
  limitations jsonb not null default '[]',
  engine_version text not null,
  fingerprint text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 1,
  created_at timestamptz not null default now(),
  unique (monitor_id, fingerprint)
);

create index if not exists idx_correlation_events_monitor on correlation_threat_events (monitor_id, created_at desc);
create index if not exists idx_correlation_events_user on correlation_threat_events (user_id, created_at desc);

-- D6-F §76: minimal correlation alert rule knobs on the existing rules row.
alter table monitor_alert_rules add column if not exists notify_correlation_change boolean not null default true;
alter table monitor_alert_rules add column if not exists correlation_min_score integer not null default 40;
alter table monitor_alert_rules add column if not exists correlation_min_confidence numeric not null default 0.5;

-- ---------------------------------------------------------------------------
-- D6-H: webhooks. The signing secret is encrypted at rest (AES-256-GCM;
-- ciphertext + nonce + key version). NEVER store the plaintext (§101).
-- Delivery attempts persist in webhook_deliveries (bounded error excerpt
-- only, §111). Status: ACTIVE | DEGRADED | DISABLED (§113).
-- ---------------------------------------------------------------------------
create table if not exists developer_webhooks (
  id bigserial primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  url text not null,
  status text not null default 'ACTIVE',
  event_types jsonb not null default '[]',
  secret_encrypted text not null,
  secret_nonce text not null,
  secret_key_version text not null default 'v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer not null default 0,
  disabled_at timestamptz,
  disabled_reason text
);

create index if not exists idx_webhooks_user on developer_webhooks (user_id, created_at desc);

create table if not exists webhook_deliveries (
  id bigserial primary key,
  webhook_id bigint not null references developer_webhooks (id) on delete cascade,
  event_id text not null,
  event_type text not null,
  attempt integer not null default 1,
  status text not null, -- SUCCESS | RETRY | FAILED | SSRF_BLOCKED
  status_code integer,
  duration_ms integer,
  next_retry_at timestamptz,
  error_excerpt text,
  created_at timestamptz not null default now(),
  unique (webhook_id, event_id, attempt)
);

create index if not exists idx_webhook_deliveries_webhook on webhook_deliveries (webhook_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS on new user-owned tables (same auth.uid() pattern as 0002/0003/0006).
-- The API uses the service role (bypasses RLS); policies scope direct
-- client access. auth.uid() is stubbed NULL locally → no rows match.
-- ---------------------------------------------------------------------------
alter table user_wallet_identities enable row level security;
alter table sessions enable row level security;
alter table monitor_correlation_baselines enable row level security;
alter table correlation_threat_events enable row level security;
alter table developer_webhooks enable row level security;
alter table webhook_deliveries enable row level security;

create policy user_wallet_identities_select_own on user_wallet_identities
  for select using (user_id = auth.uid());
create policy user_wallet_identities_insert_own on user_wallet_identities
  for insert with check (user_id = auth.uid());
create policy user_wallet_identities_update_own on user_wallet_identities
  for update using (user_id = auth.uid());

create policy sessions_select_own on sessions
  for select using (user_id = auth.uid());
create policy sessions_delete_own on sessions
  for delete using (user_id = auth.uid());

create policy monitor_correlation_baselines_select_own on monitor_correlation_baselines
  for select using (
    exists (select 1 from privacy_monitors pm where pm.id = monitor_correlation_baselines.monitor_id and pm.user_id = auth.uid())
  );

create policy correlation_threat_events_select_own on correlation_threat_events
  for select using (user_id = auth.uid());
create policy correlation_threat_events_insert_own on correlation_threat_events
  for insert with check (user_id = auth.uid());
create policy correlation_threat_events_update_own on correlation_threat_events
  for update using (user_id = auth.uid());

create policy developer_webhooks_select_own on developer_webhooks
  for select using (user_id = auth.uid());
create policy developer_webhooks_insert_own on developer_webhooks
  for insert with check (user_id = auth.uid());
create policy developer_webhooks_update_own on developer_webhooks
  for update using (user_id = auth.uid());
create policy developer_webhooks_delete_own on developer_webhooks
  for delete using (user_id = auth.uid());

create policy webhook_deliveries_select_own on webhook_deliveries
  for select using (
    exists (select 1 from developer_webhooks w where w.id = webhook_deliveries.webhook_id and w.user_id = auth.uid())
  );
