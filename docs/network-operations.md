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

Apply migrations `0012` and `0013` with the existing migration runner. Set
`ENABLE_NETWORK_API=true` on the API, and optionally
`ENABLE_INDEXED_TRANSACTIONS=true` on the analysis worker. Install/build the
workspace normally. The product page is `/app/network` and requires a login.

Set `DATABASE_URL`, `INDEXER_CHAIN`, `INDEXER_RPC_URL`, and a numeric
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

`INDEXER_BATCH_SIZE` defaults to 32; `INDEXER_POLL_MS` defaults to 2000.
RPC calls are spaced by at least 200 ms per process. Each chain needs its own
process and RPC endpoint. Run one process per chain for efficiency; checkpoint
row locks prevent two processes committing the same batch.

The optional `docker-compose.network.yml` overlays the production compose file.
It enables the network API and indexed transaction reuse, and adds an indexer
under the `network` profile. It requires the normal production environment plus
the explicit indexer variables. Reviewer policy files must be mounted read-only
at the path configured in the API environment; no private signing key belongs
in the API container.

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

`network_blocks.raw_rpc` retains the exact RPC response text for new blocks,
including integers above JavaScript's safe range. JSONB is a query projection;
use the original response with a lossless parser for monetary auditing. Older
blocks may have no original response. The implementation does not independently
validate consensus or promise global archival completeness/throughput.

## Tests

```sh
pnpm test:network
# VPS, separate scratch database and Redis (not production):
NETWORK_TEST_DATABASE_URL=... REDIS_URL=... pnpm test:network:operations
```

The operations test refuses an existing `profiles` table instead of clearing it.
It applies all migrations and checks real session/API-key authentication,
pagination, claim import/revocation, isolated balances and developer usage.
`packages/network/src/live-check.ts` separately tests small mainnet ranges in
a fresh database named `network_live_test`; it never writes mainnet.
