-- Additive indexes. Retention deletes by height, and deleting a transaction
-- makes PostgreSQL check its child rows in network_transaction_addresses; the
-- existing primary keys lead with chain,address and chain,tx_id respectively,
-- so without these a prune degrades into a sequential scan per deleted parent
-- row. Measured on a 16-block live sample (22,749 transactions, 320,042
-- memberships): removing two blocks took 53 seconds before these indexes.
create index network_transaction_addresses_tx on network_transaction_addresses (chain, tx_id);
create index network_transaction_addresses_height on network_transaction_addresses (chain, height);
create index network_transactions_height on network_transactions (chain, height);
