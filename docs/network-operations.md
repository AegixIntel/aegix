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
The personal AEX route has no developer equivalent. Chain values are
`solana:mainnet`, `eip155:1` and `eip155:8453`; URL-encode path components.

History accepts `limit` from 1 to 100, and `beforeHeight` + `beforePosition`
together. Use the returned `nextCursor` pair to load the next page. Coverage
is bounded; no transactions is not a clean reputation or proof of an unused
wallet. Solana account membership means involvement, not wallet ownership.
EVM indexes outer sender/recipient and exact requested native value; receipts,
internal calls and token logs are not indexed, so execution status is unknown.

The worker uses only indexed **parsed** Solana transactions with a matching
signature; older unparsed JSON, missing rows, and index errors fall back to RPC.
Signature discovery/account classification still uses the existing RPC path.
Both the block indexer and existing transaction reader opt into
`maxSupportedTransactionVersion: 1`. Otherwise a single v1 transaction causes
the entire block request to fail with `-32015`. Parsed message configuration
is retained; this service does not construct/sign v1 transactions. See
[Solana's versioned transaction documentation](https://solana.com/docs/core/transactions/versioned-transactions).

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

## Internal $AEX accounting

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
