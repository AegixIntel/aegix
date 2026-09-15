# Milestone D12 — Network Foundation

Written for: engineers working on this repository, and operators running the
deployment.

D12 adds `@aegix/network`: bounded finalized-block ingestion for Solana mainnet,
Ethereum and Base; persisted, signature-verified reputation evidence; internal
$AEX accounting; and the read paths that expose them. It implements the
infrastructure behind §118 (incremental indexer), §121 (multi-chain), §65
(wallet reputation) and §124 (feature flags). It adds no intelligence, changes
no score, and touches no analysis engine.

The central design constraint is the same shape as D11's: **the new surfaces
are wired in, but every one of them is off by default, so an existing
deployment behaves exactly as it did before D12 existed.**

> **`ENABLE_NETWORK_API=false` and `ENABLE_INDEXED_TRANSACTIONS=false` are the
> defaults. With both off, the API exposes no network route, the worker resolves
> every transaction over RPC exactly as before, and no ingestion process runs
> unless an operator starts one.**

There is no automatic process: the indexer is a CLI an operator runs, per chain.
Nothing in the API, worker or web app fetches outside the existing RPC path.

---

## 1. What is and is not built

Built:

```text
finalized block ingestion     bounded scan, exact RPC retention (raw_rpc),
                              transaction + address projections, PostgreSQL
                              cursor, atomic batch commits, archive floor
                              check, parent-continuity verification
chain adapters                solana:mainnet, eip155:1, eip155:8453, each
                              verified against its genesis hash / chain id
wallet history read path      keyset-paginated involvement API + /app/network
reputation evidence           versioned, domain-separated signed claims;
                              distinct-reviewer quorum, expiry, revocation
$AEX internal accounting      replay-protected atomic transfers between
                              pre-funded accounts; journal + balances
worker transaction reuse      indexed parsed Solana transactions with RPC
                              fallback; maxSupportedTransactionVersion 1
operator CLI                  indexer (one batch / --follow / --backfill),
                              reputation:import, reputation:revoke,
                              aex:transfer, aex:sandbox-open
migrations 0012, 0013         network, evidence and accounting tables
```

Not built, and not to be described as available:

```text
public reputation score       no labelled dataset, no calibrated model, no
                              risk band. Every score field is null and the
                              API says why
on-chain $AEX                 no mint, no custody, no deposit/withdrawal,
                              no staking lockup or slashing, no governance.
                              Internal bookkeeping only
EVM privacy analysis          outer sender/recipient and the requested native
                              value only; no receipts, internal calls, token
                              logs or traces, so execution status is unknown
cross-chain ownership         no inference that one entity controls addresses
                              across chains
lifetime archive              the start height is permanent per chain cursor;
                              history before it does not exist for AEGIX
```

## 2. What was built

```text
packages/network            ingestion, projections, cursor, RPC adapters,
                            reputation store, ledger, query service, CLI.
                            Depends on postgres + bs58 only
migration 0012              network_blocks, indexed_transactions,
                            indexed_addresses, reputation tables, aex ledger
migration 0013              operations tables for the read/evidence/accounting
                            paths
apps/api                    registerNetwork: /v1/network/status|history|
                            reputation, /v1/developer/network/* (metered,
                            intelligence:read), /v1/me/aex — account id from
                            the verified session only, never a parameter
apps/worker                 indexed transaction reuse in the analysis path
apps/web                    /app/network — history, reviewed evidence, the
                            signed-in user's internal accounting balance
infra                       indexer.Dockerfile; optional
                            docker-compose.network.yml overlay
```

Enforcement and trust boundaries held: the network package exposes no public
write endpoint; trusted reviewer keys, quorum and dataset version come from an
operator-supplied policy file, never from a request; evidence is capped at
1 MiB per claim and source URLs are not fetched; the personal accounting route
derives its account solely from the authenticated session.

## 3. Behaviour changes for an existing deployment

None with the flags off. The one change that is not behind a flag is in the
Solana reader itself: it now requests `maxSupportedTransactionVersion: 1`.
Before this, a single versioned transaction caused the whole `getBlock` /
`getTransaction` call to fail with `-32015`; opting in makes the existing
reader tolerant of v1 transactions. Parsed message configuration is retained
and this service never constructs or signs one.

## 4. Verified

Verified on `projecteon-v2` (Node 22.23.2, pnpm 9.15.9) on 2026-09-15, from a
fresh clone with isolated PostgreSQL 16 and Redis 7 containers. The running
production stack was not touched.

```text
install --frozen-lockfile              PASS
typecheck / lint                       PASS
build (packages, apps, web)            PASS
unit tests                             549 / 549, 0 failures
test:migrations                        PASS  (13 migrations)
test:network:operations                PASS  (13 migrations applied)
test:web-routing                       PASS
docker build indexer.Dockerfile        PASS
```

`test:network:operations` runs against a dedicated scratch database and checks
real session and API-key authentication, wallet pagination, an invalid cursor,
chain isolation, signed evidence import (including replay and tampering),
revocation, a ledger payout, per-account isolation, and developer scope plus
metering. It refuses to run against a database that already has a `profiles`
table rather than clearing it.

Pipeline on 2026-09-15: PR #11 green on all eight jobs, including the two it
added — the indexer image build and the network operations suite — then merged
to `main` as `5425147` with main CI green.

## 5. Defects found and fixed during the build

**The worker test suite was not running most of its tests.** `apps/worker` and
`apps/web` passed the test glob unquoted, so the shell expanded it before node
saw it. Without globstar, `src/**/*.test.ts` becomes `src/*/*.test.ts`, which
matches nested files only: the worker suite ran `src/processors/billing.test.ts`
alone (15 tests) and silently skipped every `src/*.test.ts`, including the new
`indexed-transaction.test.ts`. Quoting the pattern, as every `packages/*`
script already does, hands the glob to node and restores the suite to 18 tests.
This is why the milestone records 549 tests: it is the first measurement where
the worker suite is complete.

**A stale migration report.** The migration harness still printed "11
migrations passed" after `0012` and `0013` landed. The assertions already
expected 13; only the message was wrong.

## 6. Still open

```text
scale and storage             partitions, pruning, provider redundancy, rate
                              limiting, sustained mainnet throughput
live ingestion                a bounded range has been exercised; sustained
                              live mainnet ingestion has NOT been run
load validation               no load or concurrency test has been run
                              against the indexer or the read paths
signature discovery           the analysis worker still discovers signatures
                              over RPC; reusing the index for discovery waits
                              on proven coverage/freshness admission
reputation model              needs a licensed labelled dataset, a defined
                              prediction target, wallet-and-time split,
                              calibration and false-positive measurement
tokenomics                    mint, decimals, issuance, custody, utilities,
                              treasury authority and audit — none supplied
EVM normalization             receipts, logs and traces before multi-chain
                              wallet analysis can be advertised as available
```

None of these blocks deployment of the existing product: with the flags off,
D12 is inert.
