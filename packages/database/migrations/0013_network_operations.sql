alter table network_checkpoints add column finalized_height bigint;
alter table network_checkpoints add column last_error text;
alter table network_checkpoints add column heartbeat_at timestamptz;
-- Preserve the exact RPC envelope, including Solana integers above JS safe range.
alter table network_blocks add column raw_rpc text;
create table network_transactions (
  chain text not null,
  tx_id text not null,
  height bigint not null,
  position integer not null,
  block_time timestamptz,
  success boolean,
  sender text,
  recipient text,
  value_atomic text,
  raw jsonb not null,
  primary key (chain, tx_id),
  foreign key (chain, height) references network_blocks(chain, height)
);
create table network_transaction_addresses (
  chain text not null,
  address text not null,
  tx_id text not null,
  height bigint not null,
  position integer not null,
  primary key (chain, address, tx_id),
  foreign key (chain, tx_id) references network_transactions(chain, tx_id)
);
create index network_wallet_history on network_transaction_addresses (chain, address, height desc, position desc);
create table network_projections (
  chain text not null,
  height bigint not null,
  primary key (chain, height),
  foreign key (chain, height) references network_blocks(chain, height)
);
create table reputation_claims (
  id text primary key,
  chain text not null,
  address text not null,
  dataset_version text not null,
  payload jsonb not null,
  evidence bytea not null,
  payload_digest text not null,
  imported_at timestamptz not null default now(),
  revoked_at timestamptz,
  revocation_reason text
);
create index reputation_wallet on reputation_claims (chain, address, imported_at desc);
create table aex_openings (
  event_key text primary key,
  account_id text not null unique references aex_accounts(id),
  amount numeric(78,0) not null check (amount >= 0),
  mode text not null check (mode = 'SANDBOX'),
  created_at timestamptz not null default now()
);
-- Server/operator connections own these tables; direct client roles get no policies.
alter table reputation_claims enable row level security;
alter table aex_accounts enable row level security;
alter table aex_transfers enable row level security;
alter table aex_openings enable row level security;
