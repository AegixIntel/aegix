-- AEGIX initial schema.
-- See architecture.md §12-§17, §175 for the conceptual model this implements.

-- ============================================================
-- Identity / profiles
-- ============================================================

create table if not exists profiles (
  id uuid primary key,
  display_name text,
  plan text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Wallet registry
-- ============================================================

create table if not exists wallets (
  id bigserial primary key,
  chain text not null,
  address text not null,
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  last_analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain, address)
);

create index if not exists idx_wallets_last_analyzed_at on wallets (last_analyzed_at);

-- ============================================================
-- Analysis jobs
-- ============================================================

create table if not exists analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  wallet_id bigint not null references wallets (id) on delete cascade,
  requested_by uuid references profiles (id) on delete set null,
  analysis_type text not null default 'full',
  status text not null default 'CREATED',
  priority text not null default 'standard',
  progress integer not null default 0,
  engine_version text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_message text,
  chain_data_until timestamptz,
  fresh_until timestamptz,
  data_quality jsonb
);

create index if not exists idx_analysis_jobs_wallet_created on analysis_jobs (wallet_id, created_at desc);
create index if not exists idx_analysis_jobs_status on analysis_jobs (status);

-- ============================================================
-- Normalized blockchain data
-- ============================================================

create table if not exists transactions (
  id bigserial primary key,
  signature text not null,
  slot bigint not null,
  block_time timestamptz not null,
  wallet_id bigint not null references wallets (id) on delete cascade,
  success boolean not null default true,
  fee bigint not null default 0,
  transaction_class text not null default 'UNKNOWN',
  raw_provider text,
  parser_version text,
  created_at timestamptz not null default now(),
  unique (signature, wallet_id)
);

create index if not exists idx_transactions_wallet_time on transactions (wallet_id, block_time desc);

create table if not exists transfers (
  id bigserial primary key,
  transaction_id bigint not null references transactions (id) on delete cascade,
  from_address text not null,
  to_address text not null,
  asset_type text not null,
  mint text,
  amount_raw text not null,
  amount_normalized numeric not null,
  transfer_type text not null default 'TRANSFER',
  block_time timestamptz not null
);

create index if not exists idx_transfers_from on transfers (from_address);
create index if not exists idx_transfers_to on transfers (to_address);
create index if not exists idx_transfers_pair on transfers (from_address, to_address);
create index if not exists idx_transfers_time on transfers (block_time);
create index if not exists idx_transfers_mint on transfers (mint);

create table if not exists program_interactions (
  id bigserial primary key,
  wallet_id bigint not null references wallets (id) on delete cascade,
  transaction_id bigint not null references transactions (id) on delete cascade,
  program_id text not null,
  program_label text,
  protocol_category text not null default 'UNKNOWN',
  action_type text not null default 'UNKNOWN',
  block_time timestamptz not null
);

create index if not exists idx_program_interactions_wallet on program_interactions (wallet_id);
create index if not exists idx_program_interactions_program on program_interactions (program_id);

-- ============================================================
-- Entity registry
-- ============================================================

create table if not exists entities (
  id bigserial primary key,
  name text not null,
  entity_type text not null,
  description text,
  status text not null default 'UNVERIFIED',
  default_confidence numeric not null default 0.5,
  source_type text not null default 'INTERNAL',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists entity_addresses (
  id bigserial primary key,
  entity_id bigint not null references entities (id) on delete cascade,
  chain text not null,
  address text not null,
  label text,
  confidence numeric not null default 0.5,
  evidence_source text,
  first_verified_at timestamptz,
  last_verified_at timestamptz,
  status text not null default 'UNVERIFIED',
  unique (chain, address)
);

create index if not exists idx_entity_addresses_address on entity_addresses (address);

-- ============================================================
-- Relationships
-- ============================================================

create table if not exists wallet_relationships (
  id bigserial primary key,
  wallet_a text not null,
  wallet_b text not null,
  relationship_type text not null,
  direction text not null default 'BIDIRECTIONAL',
  transaction_count integer not null default 0,
  interaction_count integer not null default 0,
  total_value numeric not null default 0,
  first_seen timestamptz,
  last_seen timestamptz,
  strength_score numeric not null default 0,
  confidence_score numeric not null default 0,
  evidence_json jsonb,
  engine_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_relationships_a on wallet_relationships (wallet_a);
create index if not exists idx_relationships_b on wallet_relationships (wallet_b);
create index if not exists idx_relationships_pair on wallet_relationships (wallet_a, wallet_b);

-- ============================================================
-- Behavioral features
-- ============================================================

create table if not exists behavioral_features (
  id bigserial primary key,
  wallet_id bigint not null references wallets (id) on delete cascade,
  feature_name text not null,
  feature_value_number numeric,
  feature_value_json jsonb,
  window text not null default 'all',
  sample_size integer not null default 0,
  computed_at timestamptz not null default now(),
  engine_version text,
  unique (wallet_id, feature_name, window, engine_version)
);

-- ============================================================
-- Signals / scores / paths
-- ============================================================

create table if not exists exposure_signals (
  id bigserial primary key,
  analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  signal_type text not null,
  category text not null,
  severity integer not null default 0,
  confidence numeric not null default 0,
  title text not null,
  summary text,
  evidence_json jsonb,
  source_engine text,
  engine_version text,
  created_at timestamptz not null default now()
);

create index if not exists idx_signals_analysis on exposure_signals (analysis_id);

create table if not exists exposure_scores (
  id bigserial primary key,
  analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  overall_score integer not null default 0,
  identity_linkability integer not null default 0,
  funding_exposure integer not null default 0,
  wallet_cluster_exposure integer not null default 0,
  behavioral_fingerprint integer not null default 0,
  counterparty_exposure integer not null default 0,
  entity_exposure integer not null default 0,
  transaction_pattern_exposure integer not null default 0,
  overall_confidence numeric not null default 0,
  scoring_version text,
  created_at timestamptz not null default now()
);

create index if not exists idx_scores_wallet_created on exposure_scores (wallet_id, created_at desc);

create table if not exists exposure_paths (
  id bigserial primary key,
  analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  target_wallet_id bigint not null references wallets (id) on delete cascade,
  rank integer not null default 0,
  path_type text not null default 'ATTRIBUTION',
  nodes_json jsonb,
  edges_json jsonb,
  path_score numeric not null default 0,
  confidence_score numeric not null default 0,
  summary text,
  engine_version text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Reports / usage
-- ============================================================

create table if not exists analysis_reports (
  id bigserial primary key,
  analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  report_version text not null default 'v1',
  summary_json jsonb,
  generated_text text,
  created_at timestamptz not null default now()
);

create table if not exists usage_records (
  id bigserial primary key,
  user_id uuid references profiles (id) on delete set null,
  anonymous_key text,
  analysis_id uuid references analysis_jobs (id) on delete set null,
  usage_type text not null,
  wallet_id bigint references wallets (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_usage_user_day on usage_records (user_id, created_at);
create index if not exists idx_usage_anon_day on usage_records (anonymous_key, created_at);
