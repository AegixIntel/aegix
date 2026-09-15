-- Additive, opt-in infrastructure. Existing wallet/analysis tables are untouched.
create table network_checkpoints (
  chain text primary key check (chain in ('solana:mainnet', 'eip155:1', 'eip155:8453')),
  start_height bigint not null check (start_height >= 0),
  next_height bigint not null check (next_height >= start_height),
  last_height bigint,
  last_hash text,
  updated_at timestamptz not null default now(),
  check ((last_height is null) = (last_hash is null))
);
create table network_blocks (
  chain text not null references network_checkpoints(chain),
  height bigint not null check (height >= 0),
  hash text not null,
  parent_height bigint not null,
  parent_hash text not null,
  raw jsonb not null,
  indexed_at timestamptz not null default now(),
  primary key (chain, height),
  unique (chain, hash)
);
-- Internal accounting only; these balances are not on-chain token balances.
create table aex_accounts (
  id text primary key,
  balance numeric(78,0) not null default 0 check (balance >= 0)
);
create table aex_transfers (
  event_key text primary key,
  debit_account text not null references aex_accounts(id),
  credit_account text not null references aex_accounts(id),
  amount numeric(78,0) not null check (amount > 0),
  purpose text not null check (purpose in ('STAKE', 'UNSTAKE', 'VERIFICATION_REWARD', 'RESEARCH_BOUNTY', 'ECOSYSTEM_INCENTIVE')),
  evidence_ref text not null check (length(evidence_ref) > 0),
  created_at timestamptz not null default now(),
  check (debit_account <> credit_account)
);
