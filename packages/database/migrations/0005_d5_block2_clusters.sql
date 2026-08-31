-- D5 Block 2: relationship cluster hypotheses (D5-H §64).
-- Public blockchain-derived data (pattern of 0001 tables, no RLS); the API
-- layer enforces auth/quota/admission.

create table if not exists relationship_clusters (
  id bigserial primary key,
  analysis_id uuid not null references analysis_jobs (id) on delete cascade,
  wallet_id bigint not null references wallets (id) on delete cascade,
  cluster_id text not null,            -- stable fingerprint (D5-H §63)
  target_wallet text not null,
  members jsonb not null default '[]', -- [{wallet, strengthToCore, confidence, evidenceFamilies, anchor, lowData}]
  confidence numeric not null,
  evidence_families jsonb not null default '[]',
  limitations jsonb not null default '[]',
  engine_version text not null,
  created_at timestamptz not null default now(),
  unique (analysis_id, cluster_id)
);

create index if not exists idx_relationship_clusters_analysis on relationship_clusters (analysis_id);
create index if not exists idx_relationship_clusters_wallet on relationship_clusters (wallet_id);
