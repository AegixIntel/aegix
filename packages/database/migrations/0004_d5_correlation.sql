-- D5: cross-wallet correlation — correlation results, funding provenance
-- paths, behavioral feature persistence (table exists since 0001), and
-- entity registry v3 columns. See docs/milestone-d5.md (D5-B, D5-C, D5-F).

-- ---------------------------------------------------------------------------
-- Correlation results: canonical pair (wallet_a < wallet_b), idempotent.
-- Public blockchain-derived data (pattern of 0001 tables, no RLS); the API
-- layer enforces auth/quota/admission.
-- ---------------------------------------------------------------------------
create table if not exists correlation_results (
  id bigserial primary key,
  wallet_a text not null,
  wallet_b text not null,
  correlation_score integer not null,
  confidence numeric not null,
  classification text not null,
  evidence_families jsonb not null default '[]',
  limitations jsonb not null default '[]',
  engine_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wallet_a, wallet_b)
);

create index if not exists idx_correlation_a on correlation_results (wallet_a);
create index if not exists idx_correlation_b on correlation_results (wallet_b);

-- ---------------------------------------------------------------------------
-- Funding provenance paths: bounded multi-hop funding chains (D5-C).
-- target_wallet_id -> ordered hops ending at a wallet or entity terminus.
-- ---------------------------------------------------------------------------
create table if not exists funding_paths (
  id bigserial primary key,
  target_wallet_id bigint not null references wallets (id) on delete cascade,
  path jsonb not null, -- [{hop, fromAddress, toAddress, strength, confidence, transferCount, totalValue, firstSeen, lastSeen}]
  path_score numeric not null,
  path_confidence numeric not null,
  terminus_type text not null, -- ENTITY | WALLET
  terminus_address text not null,
  terminus_entity_name text,
  engine_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_funding_paths_target on funding_paths (target_wallet_id);

-- ---------------------------------------------------------------------------
-- Entity registry v3 (D5-F): address roles, deprecation, notes.
-- first_verified_at is now written on insert (was a dead column).
-- ---------------------------------------------------------------------------
alter table entity_addresses add column if not exists address_role text not null default 'UNKNOWN_ROLE';
alter table entity_addresses add column if not exists deprecated_at timestamptz;
alter table entity_addresses add column if not exists notes text;

-- Reproducibility: record the registry version used by an analysis (D5-F §42).
alter table analysis_jobs add column if not exists registry_version text;

-- Idempotent relationship upserts (D5-G §46): one row per canonical pair + type.
create unique index if not exists idx_relationships_pair_type
  on wallet_relationships (wallet_a, wallet_b, relationship_type);
