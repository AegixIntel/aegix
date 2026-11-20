# Network operations

The network package now has an operational read path:

```text
Finalized RPC blocks -> atomic block + transaction/address projections
                    -> wallet history API -> /app/network
                    -> parsed Solana transaction reuse in analysis worker
Signed evidence file -> trusted-policy verification -> stored claims -> reputation API
Operator transfer -> atomic internal ledger -> authenticated /v1/me/aex
```

## Enable

Apply migrations `0012` through `0014` with the existing migration runner. Set
`ENABLE_NETWORK_API=true` on the API, and optionally
`ENABLE_INDEXED_TRANSACTIONS=true` on the analysis worker. Install/build the
workspace normally. The product page is `/app/network` and requires a login.

Set `DATABASE_URL`, `INDEXER_CHAIN`, an RPC endpoint, and a numeric
`INDEXER_START_HEIGHT`. The start is permanent for that chain's cursor; never
claim history earlier than it. Use archive-capable RPC to backfill old data.

```sh
# One batch
pnpm --filter @aegix/network indexer
# Continuous indexing, SIGTERM/SIGINT drain, automatic retry/backoff
pnpm --filter @aegix/network indexer --follow
# Project older stored blocks, 16 per invocation, repeat until projected=0
pnpm --filter @aegix/network indexer --backfill
```

`INDEXER_RPC_URLS` takes a comma-separated list of independent providers and is
preferred over the single `INDEXER_RPC_URL`: a request that fails at the
transport level, returns a non-2xx status or returns unparseable JSON moves to
the next endpoint and cools the failing one down for `INDEXER_RPC_COOLDOWN_MS`.
A well-formed JSON-RPC rejection (for example `-32015`) is an answer rather than
an outage, so it does not rotate away from a working endpoint. Endpoint URLs are
never written to logs or errors, because they routinely carry an API key.

| Variable | Default | Meaning |
|---|---:|---|
| `INDEXER_BATCH_SIZE` | 32 | Slots/blocks per batch (maximum 256) |
| `INDEXER_POLL_MS` | 2000 | Delay between idle batches |
| `INDEXER_RPC_MIN_INTERVAL_MS` | 200 | Minimum spacing per endpoint |
| `INDEXER_RPC_TIMEOUT_MS` | 30000 | Per-request timeout |
| `INDEXER_RPC_MAX_ATTEMPTS` | endpoint count | Attempts across endpoints |
| `INDEXER_RPC_COOLDOWN_MS` | 30000 | How long a failed endpoint is skipped |
| `INDEXER_VERIFY_EVERY_BATCHES` | 60 | Re-run the network and archive-floor checks at this cadence |

Each chain needs its own process and RPC endpoint. Run one process per chain for
efficiency; checkpoint row locks prevent two processes committing the same batch.
The network identity and archive-floor checks always run on the first batch and
after any failure, then every `INDEXER_VERIFY_EVERY_BATCHES` batches — repeating
them every batch only spends provider calls on an answer that cannot change
between adjacent heights.

The optional `docker-compose.network.yml` overlays the production compose file.
It enables the network API and indexed transaction reuse, and adds an indexer
under the `network` profile. It requires the normal production environment plus
the explicit indexer variables. Reviewer policy files must be mounted read-only
at the path configured in the API environment; no private signing key belongs
in the API container.

## Deployed configuration (11 October 2026)

The read APIs are **on** in production. Ingestion is a bounded window rather than
a follower, and the measurements below are the reason:

```text
ENABLE_NETWORK_API=true, ENABLE_INDEXED_TRANSACTIONS=true
                                   production.env, passed through by
                                   docker-compose.production.yml — without that
                                   pass-through the flags never reach the
                                   container and every route answers 403
INDEXER_CHAIN=solana:mainnet
INDEXER_RPC_URLS                   the existing production RPC endpoint
window                             heights 455,766,744 to 455,768,999 —
                                   2,256 blocks, about fifteen minutes of
                                   chain, 2,462,374 transactions and
                                   30,616,712 address memberships in 38 GB
reputation                         NOT_CONFIGURED; no reviewed policy is mounted
EVM chains                         not indexed

one Solana mainnet block           6.38 MB from the RPC, 19.75 MB stored,
                                   3.33 s to index
the head                           2.5 blocks/s
```

No follower on this host can keep up: the indexer needs 3.33 s per block while
the head produces 2.5 a second, which is what the 85-minute run in
`milestone-d13-network-hardening.md` already showed. So the operator indexes a
fixed range, stops, and the API reports exactly that range — `coverage`,
`retained_floor` and the `limitations` on every answer.

`INDEXER_START_HEIGHT` is written once into `network_checkpoints.start_height`
and only compared afterwards, so it is a one-way door: a smaller start height
cannot be set later for the same chain. Choose it deliberately.

Extending coverage means running the CLI again from the stored `next_height`.
Keeping coverage *fresh* needs partitioning and an automatic retention window,
neither of which exists yet — that is the milestone, not a flag.

## API

Session tokens use the existing `Authorization: Bearer ...` header. Developer
routes use existing API keys with `intelligence:read` scope, one quota unit per
successful admitted read, and existing usage records/rate limiting.

| Session route | Purpose |
| --- | --- |
| `GET /v1/network/status` | Chain capabilities, configured range, cursor, finalized head, heartbeat/error |
| `GET /v1/network/history/:chain/:address` | Transaction involvement with keyset pagination |
| `GET /v1/network/reputation/:chain/:address` | Current verified claims, or explicit unconfigured status |
| `GET /v1/me/aex` | Only the authenticated user's internal balance and recent journal entries |

For developer equivalents, replace `/v1/network` with `/v1/developer/network`.
The personal accounting route has no developer equivalent. Chain values are
`solana:mainnet`, `eip155:1` and `eip155:8453`; URL-encode path components.

History accepts `limit` from 1 to 100, and `beforeHeight` + `beforePosition`
together. Use the returned `nextCursor` pair to load the next page. Coverage
is bounded; no transactions is not a clean reputation or proof of an unused
wallet. Solana account membership means involvement, not wallet ownership.
EVM indexes outer sender/recipient, the native value sent, and execution status
from each block's receipts (see below). Internal calls are not indexed, and token
transfers are stored on the block but not yet served.

The worker uses only indexed **parsed** Solana transactions with a matching
signature; older unparsed JSON, missing rows, and index errors fall back to RPC.
Signature discovery/account classification still uses the existing RPC path.
Both the block indexer and existing transaction reader opt into
`maxSupportedTransactionVersion: 1`. Otherwise a single v1 transaction causes
the entire block request to fail with `-32015`. Parsed message configuration
is retained; this service does not construct/sign v1 transactions. See
[Solana's versioned transaction documentation](https://solana.com/docs/core/transactions/versioned-transactions).

## EVM receipts and what a block costs (measured 20 November 2026)

For every EVM block the indexer also calls `eth_getBlockReceipts` and accepts
the list only when it is exactly the block's: the same count, the same order,
the same transaction hashes and the same block hash. A pre-Byzantium receipt
(state root, no status) or a removed log fails the batch rather than being read
as success or failure. What is kept, in `network_blocks.receipts` (migration
`0019`): status, gas used, effective gas price, the sender, and the logs whose
first topic is `Transfer(address,address,uint256)`. `logsBloom` and every other
log are dropped. `network_transactions.success` comes from that receipt.

A stored EVM block keeps transaction hashes only and no `raw_rpc`: each
transaction is stored whole in `network_transactions` in the same database
transaction, and EVM quantities are hex strings that JSON cannot round. Such a
block cannot be re-projected by `--backfill`; it never needs to be, because it
is projected when it is written.

Measured on Ethereum mainnet through the public endpoint
`https://ethereum-rpc.publicnode.com`, into a throwaway PostgreSQL 16 database
on this host, heights 26,450,642–26,450,741:

```text
blocks               100
transactions         27,945   every one with a matching receipt
reverted             156      success = false
unknown status       0
Transfer logs kept   35,268
RPC calls            221      block + receipts per height, plus batch checks
time                 54 s     0.54 s per block; the chain makes one every 12 s
network_blocks       9.2 MB   slim header + trimmed receipts
network_transactions 44.5 MB  full transaction payloads
memberships          32.9 MB
total                0.825 MB per block
5 GB budget          about 6,200 blocks, roughly 20.7 hours of chain
```

Unlike Solana (3.33 s per block against a head that moves every 0.4 s), the
indexer runs some 22 times faster than Ethereum produces blocks, so a follower
on this host could keep up. Ethereum is still not indexed in production.

## EVM transfers and their cost (measured 20 November 2026)

Migration `0020` adds `network_transfers`. Each successful EVM transaction
records, at projection time:

- its native amount (ordinal `-1`), when it has a recipient and a non-zero
  value. A contract creation's value is not listed, because the created address
  is not kept;
- every receipt log that decodes as ERC-20 `Transfer` (three topics, a 32-byte
  amount) or ERC-721 `Transfer` (four topics, empty data), at its log index.
  Topics that are not zero-padded addresses, and any other shape, are skipped.

A reverted transaction, or one without a receipt, records nothing. Internal
calls (value moved by contract code) and ERC-1155 are not read. Any contract
can emit `Transfer`, so the emitting contract is stored and never treated as
verified. The parties of a token transfer also join
`network_transaction_addresses`, so a token recipient sees the transaction in
wallet history. The zero address (mints and burns) is left out of memberships;
it would gather a row for every such event. Retention removes transfers with
their block.

Read path: `GET /v1/network/transfers/:chain/:address` (and the developer
`/v1/developer/network/transfers/...`), EVM chains only, newest first, paged by
`beforeHeight` + `beforePosition` + `beforeOrdinal`. Each row carries a
direction (`IN`, `OUT`, `SELF`) relative to the requested wallet.

Measured the same way as above, heights 26,453,321–26,453,420:

```text
blocks               100
transactions         21,909   201 reverted, 0 unknown
transfers            46,910   6,563 native, 40,023 ERC-20, 324 ERC-721
time                 56 s     0.56 s per block (no extra RPC calls)
network_blocks       8.5 MB
network_transactions 37.0 MB
memberships          45.3 MB  81,494 rows, now including token parties
network_transfers    33.3 MB
total                1.184 MB per block
5 GB budget          about 4,300 blocks, roughly 14.4 hours of chain
```

## Ethereum and Base in production (switched on 20 November 2026)

Continuous Ethereum mainnet and Base followers run beside the production stack.
They are operator-run, not compose services.

- **Container:** `aegix-netindex-eth`, image `aegix-indexer:<sha>` built from
  `infra/docker/indexer.Dockerfile` at the production commit. It runs on network
  `aegix_default`, with `--memory 1g`, `--restart unless-stopped` and log
  rotation (`max-size=10m`, `max-file=3`).
- **Settings:** `~/aegix-eth/indexer.env` (mode 600) holds `INDEXER_CHAIN=eip155:1`,
  the start height (5 blocks below finalized at switch-on: 26,453,578), the
  public RPC `https://ethereum-rpc.publicnode.com`, batch 8, poll 4 s, an RPC
  interval of 150 ms, `--max-old-space-size=768`, and the production
  `DATABASE_URL`.
- **Base:** container `aegix-netindex-base`, with the same flags and image.
  `~/aegix-eth/indexer-base.env` sets `INDEXER_CHAIN=eip155:8453`, start height
  59,780,340, the public RPC `https://base-rpc.publicnode.com`, batch 16 and
  poll 2 s. Behind that endpoint's load balancer, one node reported a
  `finalized` height about 2,000 blocks behind the others. The follower only
  waits when it meets that node, because it never reads above the finalized
  height it was given.
- **Retention:** `~/aegix-eth/retention.sh` runs from cron every 15 minutes. It
  uses `operator.js network:prune` to keep the newest 4,300 Ethereum blocks
  (about 5 GB at 1.18 MB per block, roughly 14 hours) and the newest 43,200 Base
  blocks (about 4 GB at 0.095 MB per block, 24 hours). If free disk falls under
  3 GB it stops both followers. It logs to `~/aegix-eth/retention.log`.
- **Base cost:** measured on 200 blocks (59,777,645–59,777,844) at 0.095 MB per
  block and 0.41 s per block, against a 2 s block time. That sample held 3,985
  transactions (229 reverted, 0 unknown) and 5,809 transfers.
- **Solana window retired:** the bounded Solana window from October 2026
  (2,256 blocks, 2.46 million transactions, 30.6 million memberships) was pruned
  with `network:prune`. `VACUUM FULL` then returned its space to the host, about
  100 seconds with both followers stopped. The production database went from
  39 GB to 1.6 GB, and free disk went from 13 GB to 51 GB (47% used). The Solana
  checkpoint row stays, so Solana history reads report every block as pruned
  rather than as a wallet with no activity.

To upgrade after a deploy, build `aegix-indexer:<new sha>`, then recreate the
container with the same flags and env file. Update the image tag in
`retention.sh`. The checkpoint keeps its start height, so the follower resumes
where it stopped.

## EVM wallet signals

`GET /v1/network/signals/:chain/:address` (and the developer equivalent), EVM
chains only, reads the wallet's most recent 2,000 transfers in the indexed range
and returns observations, never a score:

- activity: incoming, outgoing and self transfers, native amount in and out,
  distinct token contracts, and zero-amount token transfers received;
- earliest funding: the earliest incoming native transfer in the range, which
  is not necessarily the wallet's first;
- the ten busiest counterparties, excluding the zero address, with their first
  and last block;
- look-alikes, the address-poisoning guard. A counterparty is genuine only when
  the wallet signed a transaction that moved a non-zero amount to it. Any other
  counterparty sharing a genuine one's first and last four hex characters is
  listed, in either direction, because a token contract can emit a zero-amount
  `Transfer` "from" the victim.

Every signal is computed from rows `/transfers` also returns, so each one can be
checked. The response says when the 2,000-transfer sample was cut short.

## Import reputation evidence

Create an operator-controlled JSON policy, with actual Ed25519 public PEM keys:

```json
{
  "datasetVersion": "your-reviewed-dataset-v1",
  "quorum": 2,
  "reviewers": { "reviewer-a": "<public PEM>", "reviewer-b": "<different public PEM>" },
  "revokedClaimIds": []
}
```

Set `REPUTATION_POLICY_FILE` to its absolute path for both API and operator
processes. The import envelope is `{ "item": { "claim": {...}, "reviews": [...] },
"evidenceBase64": "..." }`. `claimPayload(claim)` exports the exact bytes each
reviewer signs. See the exported `ReputationClaim` and `SignedClaim` interfaces.
Evidence is limited to 1 MiB per claim; source URLs are not fetched by the API.

### Reviewer CLI

Reviewers do not need to write code. `pnpm --filter @aegix/network reviewer`
runs offline, with no database and no credentials. Private keys stay on the
reviewer's machine, and existing files are never overwritten.

```sh
# Once per reviewer. Send only <id>.pub.pem to the operator.
pnpm --filter @aegix/network reviewer keygen --id alice --out ~/aegix-review/keys

# Draft a claim. The evidence digest is computed from the file, never typed.
# The command checks what the importer checks: label, HTTPS source, address,
# dates, 1 MiB limit.
pnpm --filter @aegix/network reviewer draft --id case-2026-001 --chain eip155:1 \
  --address 0x... --label CONFIRMED_FRAUD --source-url https://... \
  --evidence ./case-2026-001.pdf --dataset reviewed-v1 --expires 2027-11-20T00:00:00Z \
  --out case-2026-001.json

# Each reviewer signs the same file, in turn. With --policy, earlier
# signatures are checked first, so a claim edited after someone signed it is
# refused.
pnpm --filter @aegix/network reviewer sign case-2026-001.json --reviewer alice \
  --key ~/aegix-review/keys/alice.key.pem --policy policy.json

# Operator: check against the policy, then build the import envelope.
pnpm --filter @aegix/network reviewer verify case-2026-001.json --evidence ./case-2026-001.pdf --policy policy.json
pnpm --filter @aegix/network reviewer envelope case-2026-001.json --evidence ./case-2026-001.pdf --out case-2026-001.import.json
```

The policy's `reviewers` map takes the `policyEntry` that `keygen` prints. A
claim needs signatures from `quorum` distinct reviewers, at least two.

```sh
pnpm --filter @aegix/network operator reputation:import /secure/reviewed-claim.json
pnpm --filter @aegix/network operator reputation:revoke case-id "Reason for revocation"
```

Imports reject changed claims using an existing ID, wrong digests, stale claims,
unknown/duplicate reviewers, and insufficient signatures. Reads verify again
against the current policy and database revocations, without cached scores.
The latest 100 claims for the approved dataset are evaluated; `truncated=true`
explicitly identifies a larger result set. Scores remain null until there is
a calibrated, evaluated model. No synthetic labels are shipped as real data.

## Internal accounting ledger (not $AGX)

Public users cannot provision or fund accounts. The operator transfer command
uses a JSON file matching `AexTransfer`:

```json
{
  "eventKey": "approved-bounty-123",
  "debitAccount": "treasury",
  "creditAccount": "user:<verified-profile-uuid>",
  "amount": "100",
  "purpose": "RESEARCH_BOUNTY",
  "evidenceRef": "approved-case-123"
}
```

```sh
pnpm --filter @aegix/network operator aex:transfer /secure/transfer.json
```

To exercise the flow in an isolated nonproduction database, explicitly set
`AEX_MODE=sandbox` and use `aex:sandbox-open` with a file containing
`{"eventKey":"test-opening-1","accountId":"treasury","amount":"1000"}`.
Open the recipient with amount `"0"` and a separate event key, then transfer.
Openings are journalled/idempotent and are disabled when `NODE_ENV=production`.
The UI labels all balances as internal accounting, never as an on-chain token.

No production mint, token price, decimals, treasury issuance, staking lockup,
slashing rule or governance authority has been supplied. These must be defined
before implementing real token settlement; the current commands do not sign
or broadcast on-chain transactions.

## Health and maintenance

Inspect `/v1/network/status`: compare `next_height` with `finalized_height`,
and check `heartbeat_at` and `last_error`. `INDEX_BATCH_FAILED` preserves the
cursor; investigate provider availability, archive coverage, schema readiness,
and finalized parent continuity. Logs deliberately omit connection URLs and
driver messages that may contain credentials.

The failure line carries a class an operator can act on: `reason`/`status` for a
transport or HTTP failure, `rpcCode` for a provider rejection, and `sqlState`
for a database error — `22P05`, for instance, is a payload PostgreSQL refuses to
store, which is a code change rather than a retry. A driver message is never
logged, because it can quote the row being written.

`network_blocks.raw_rpc` retains the exact RPC response text for new blocks,
including integers above JavaScript's safe range. JSONB is a query projection;
use the original response with a lossless parser for monetary auditing. Older
blocks may have no original response. The implementation does not independently
validate consensus or promise global archival completeness/throughput.

A `jsonParsed` envelope can carry a NUL code point inside its strings — slot
425503014 has seven, in vote account seed fields. PostgreSQL cannot represent
U+0000 in `jsonb`, so the projection stores U+FFFD in its place and `raw_rpc`
keeps the exact response. Without that substitution the insert fails, the cursor
never advances, and the daemon retries the same block indefinitely.

## Retention

An unbounded archive is not a viable default. A finalized Solana block read from
mainnet measured roughly 6.6 MB while a slot lands about every 400 ms, so an
unbounded index grows on the order of a terabyte per day. `network_blocks` also
stores `raw` (the JSONB projection) alongside `raw_rpc` (the exact response
text), so both copies are paid for.

Retention is an explicit operator action, never automatic:

```sh
# Remove indexed blocks strictly below a height, in bounded batches.
INDEXER_CHAIN=solana:mainnet pnpm --filter @aegix/network operator \
  network:prune -- --before 320000000
```

Retention and ingestion do not overlap — ingestion only appends at or above the
cursor while this only removes strictly below the bound — so the command takes no
row lock on the checkpoint and cannot stall a running indexer. It refuses a bound
above the indexed cursor, removes child rows (memberships, transactions,
projections) before the block rows, and reports the floor it leaves behind.
Re-running it is a no-op once nothing below the bound remains.

Work is bounded three ways, because blocks are not uniform: `--batch` limits
blocks considered per invocation (default 64), `--row-budget` limits child rows
removed per invocation (default 50000, so a busy block cannot become an unbounded
transaction), and `--max-batches` limits the run (default 1000). Removing a block
costs roughly its transaction volume, which on mainnet is tens of thousands of
address memberships.

The deletes rely on the indexes added in migration `0014`. Without them a prune
degrades into a sequential scan per removed parent row: on a 16-block live sample
(22,749 transactions, 320,042 memberships) deleting two blocks took 53 seconds
before those indexes existed.

Pruning destroys wallet history below the floor, so the read API states the
retained floor as an explicit limitation instead of letting a pruned range read
as "this wallet has no older activity".

Partitioning `network_blocks` was considered and deliberately not done yet: it
needs the table recreated and existing rows moved, while the retention command
already bounds growth. Revisit it when a measured retention window no longer
fits the deployment's disk.

## Tests

```sh
pnpm test:network
# VPS, separate scratch database and Redis (not production):
NETWORK_TEST_DATABASE_URL=... REDIS_URL=... pnpm test:network:operations
# Ingestion, read-path and retention load, deterministic (no provider involved):
pnpm loadtest:network -- --batches 8 --blocks 24 --queries 300 --concurrency 16
```

The operations test refuses an existing `profiles` table instead of clearing it.
It applies all migrations and checks real session/API-key authentication,
pagination, claim import/revocation, isolated balances and developer usage.
`packages/network/src/live-check.ts` separately tests small mainnet ranges in
a fresh database named `network_live_test`; it never writes mainnet.
