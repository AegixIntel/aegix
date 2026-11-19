# Network expansion: implementation and operating boundaries

Operational continuation: see [network operations](network-operations.md) for
continuous indexing, wallet history/API/UI, evidence import/revocation, worker
transaction reuse and internal accounting commands.

## Project assessment

AEGIX is a pnpm TypeScript monorepo: Next.js web, Fastify API, BullMQ workers,
PostgreSQL persistence, Redis queues/cache, and separate deterministic privacy
engines. Existing analysis is wallet-scoped and bounded; `Chain = "solana"`
describes the privacy engine, not a universal chain capability.

The whitepaper requires labelled validation data before reputation scoring and
keeps the token ($AGX, formerly $AEX) outside basic product access. This implementation preserves those
requirements and adds `@aegix/network` as an independent infrastructure package.

## Implemented

| Area | Implementation | Boundary |
| --- | --- | --- |
| Global Solana ingestion | Continuous finalized block scan, exact RPC archive, transaction/address projections, PostgreSQL cursor, atomic batch commits, archive floor checks, parent continuity, network verification | Bounded start and provider throughput; no promise of a complete lifetime archive |
| Multi-chain | Solana mainnet, Ethereum and Base ingestion adapters; chain-qualified wallet history API and UI | No EVM privacy scoring, token/log normalization, receipt processing, traces or cross-chain ownership inference |
| Reputation | Evidence import/storage, digest verification, versioned signed claims, distinct trusted Ed25519 reviewers, quorum, expiry/revocation, API and UI | No supplied labelled dataset or calibrated model; score, risk band and confidence remain null |
| Internal accounting (not $AGX) | Internal atomic-unit transfer ledger, purpose/evidence references, replay protection, locked balances and atomic journal writes | Pre-funded internal accounting only; no link to the issued $AGX mint, no on-chain custody, mint/deposit/withdrawal, staking lockups/slashing or governance |

Migrations 0012 and 0013 add network/evidence/accounting tables; 0014 adds the
indexes retention deletes and foreign-key checks depend on. The existing
analysis worker can optionally reuse indexed parsed transactions, with RPC
fallback. The new product page is `/app/network`. The network package does not
expose public write endpoints or accept untrusted reviewer policies. It is not
wired to automatic rewards or existing invoices.

## Run the indexer

Install with `pnpm install --frozen-lockfile`. Apply migrations through the
existing database migration command during your deployment process:

```sh
pnpm --filter @aegix/database migrate
```

In the indexer process environment, explicitly set:

```text
DATABASE_URL=<database connection>
INDEXER_CHAIN=solana:mainnet
INDEXER_RPC_URL=<archive-capable RPC endpoint>
INDEXER_START_HEIGHT=<first slot to retain>
INDEXER_BATCH_SIZE=32
```

```sh
pnpm --filter @aegix/network indexer
```

Each invocation scans at most 32 slots by default (maximum 256), emits the
next height and finalized head, and exits. Pass `--follow` for continuous
indexing with operational backoff/rate limits. The stored start height must match on
restart. A bounded start is not a lifetime archive; retain and disclose it.
Use `eip155:1` for Ethereum or `eip155:8453` for Base and supply that network's
RPC endpoint. The provider's genesis hash/chain ID is checked before ingestion.

A missing Solana slot in `getBlocks` is treated as not produced. An RPC failure,
pruned starting point, malformed block, or parent mismatch never advances a
batch. The implementation trusts the configured RPC's finalized block listing;
it does not independently verify validator consensus. A continuity failure
requires operator investigation; it never automatically rewrites prior blocks.
An empty range can advance the scan cursor, but preserves the last produced
block for continuity checking when the next block arrives.

Provider responses are retained exactly as text in `raw_rpc` and as parsed JSONB.
JavaScript JSON decoding does not preserve arbitrary large unquoted Solana
numeric fields exactly; use the original text with a lossless parser for audits.
Do not derive monetary settlement amounts from the JSONB projection. Economic accounting
accepts decimal strings and uses bigint/PostgreSQL numeric exclusively.

## Validated reputation evidence

`claimPayload` defines the domain-separated bytes reviewers sign. A claim binds
the wallet/network, label, HTTPS source, SHA-256 of supplied evidence bytes,
observation/expiry times and dataset version. `validateClaim` requires at least
two trusted reviewer identities **and distinct public keys**. The operator
supplies trusted keys, approved dataset version and current revocation set;
those values must never come from a public request.

`reputationReport` returns accepted provenance, rejection reasons, and either
`INSUFFICIENT_EVIDENCE`, `VALIDATED_EVIDENCE`, or `CONFLICTING_EVIDENCE`.
Signatures verify review provenance and content integrity; they do not prove
that a real-world accusation is true. The evidence itself needs a documented
review process. Legitimate observed activity does not certify a wallet as safe.

Before publishing a numeric model: obtain a licensed labelled dataset, define
the prediction target/time window, split evaluation by wallet and time, measure
calibration and false positives, publish limits, and version the approved model.
Privacy exposure scores are not inputs masquerading as fraud labels.

## Internal accounting ledger (not $AGX)

`createAexLedger(sql).transfer(...)` moves pre-funded balances with a unique
event key. Reusing the key with identical fields returns a replay; changing
any field rejects it. Missing accounts, overdrafts, self transfers, fractional
amounts and overflow reject the entire transaction. Account row locks serialize
competing transfers and the transfer record is written in the same transaction.

The official mint now exists ($AGX, `8KQjhn6PfkWK58aFUrwuMo9yZEJpGMSbmFB1ZBXApump`,
6 decimals), but this ledger is not connected to it. Operators must still supply
the funding reconciliation, approved utilities and treasury authority before it
can represent real $AGX. Account funding is not exposed by this library. Purpose
labels such as `STAKE` describe bookkeeping intent, not enforced staking rules.
There is no dependency from consumer access to these balances.

## Verification

```sh
pnpm --filter @aegix/network test
pnpm --filter @aegix/network lint
# VPS only, explicit scratch database:
NETWORK_TEST_DATABASE_URL=<scratch connection> pnpm --filter @aegix/network test:integration
```

Integration tests create a unique schema and retain it for inspection. They do
not drop/reset existing schemas or data. Tests cover checkpoint races/rollback,
duplicate payout races, conflicting payloads, overdrafts and conservation of funds.

Verified on 2026-09-15: 15 unit tests passed; package TypeScript lint passed
locally; package build and PostgreSQL 16 integration checks passed in an isolated
VPS directory and a separate temporary database container. The test container
was stopped afterward and its data retained. Production migrations, full
workspace release checks and sustained live RPC ingestion were not run.

## Remaining production work

**Amended 11 October 2026**: production now runs the read APIs over a bounded
window of finalized Solana blocks. Item 1 is partly done — the per-block cost and
rate are measured (6.38 MB from the RPC, 19.75 MB stored, 3.33 s per block) and
`network:prune` exists — but partitioning and an automatic retention window do
not, so coverage cannot be kept fresh. Items 2, 3 and 5 remain open. Item 4 is a
product and legal decision, not engineering work, and is not planned here.

1. Size/archive storage, partitions, pruning policy, ingestion metrics, provider
   redundancy, rate limiting and sustained mainnet throughput/load validation.
2. Extend signature discovery to the index once coverage/freshness admission is
   proven; current worker transaction reuse retains RPC signature discovery.
3. Supply reviewed evidence datasets and implement a calibrated reputation model
   plus appeals operations; authenticated evidence APIs and revocation are implemented.
4. Decide tokenomics and implement/audit actual mint, custody, staking and
   governance programs, reconciliation and deployment procedures.
5. Extend EVM normalization, receipts/logs and privacy engines before advertising
   multi-chain wallet analysis as available.

## Protocol references

- [Solana getBlocks](https://solana.com/docs/rpc/http/getblocks)
- [Solana getBlock](https://solana.com/docs/rpc/http/getblock)
- [Solana getGenesisHash](https://solana.com/docs/rpc/http/getgenesishash)
- [Ethereum execution API: eth_getBlockByNumber](https://ethereum.github.io/execution-apis/api/methods/eth_getBlockByNumber/)
