-- Value movements of successful EVM transactions: the native amount a
-- transaction sent, and ERC-20 / ERC-721 Transfer events from its receipt.
-- Additive; Solana rows are never written here.
create table network_transfers (
  chain text not null,
  tx_id text not null,
  -- -1 is the native amount; otherwise the event's log index in the block.
  ordinal integer not null check (ordinal >= -1),
  height bigint not null,
  position integer not null,
  kind text not null check (kind in ('NATIVE', 'ERC20', 'ERC721')),
  token text,
  sender text not null,
  recipient text not null,
  amount_atomic text,
  token_id text,
  primary key (chain, tx_id, ordinal),
  foreign key (chain, tx_id) references network_transactions(chain, tx_id),
  check ((kind = 'NATIVE') = (token is null)),
  check ((kind = 'ERC721') = (token_id is not null)),
  check ((kind = 'ERC721') = (amount_atomic is null))
);
-- Wallet reads walk one side at a time, newest first.
create index network_transfers_sender on network_transfers (chain, sender, height desc, position desc, ordinal desc);
create index network_transfers_recipient on network_transfers (chain, recipient, height desc, position desc, ordinal desc);
-- Retention deletes by height (see 0014).
create index network_transfers_height on network_transfers (chain, height);
