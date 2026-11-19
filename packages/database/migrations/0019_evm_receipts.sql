-- EVM receipts. A block's transactions say what was requested; only the
-- receipt says what executed. The indexer now fetches eth_getBlockReceipts for
-- every EVM block, checks it against the block (count, order, hashes), and
-- keeps a trimmed copy here: status, gas, sender and Transfer logs only.
-- Null for Solana blocks and for EVM blocks indexed before this column.
alter table network_blocks add column receipts jsonb;
