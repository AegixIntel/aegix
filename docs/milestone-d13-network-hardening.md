# Milestone D13 — Network hardening for sustained operation

Written for: engineers working on this repository, and operators running the
deployment.

D12 built the ingestion, evidence and accounting paths. D13 makes them survivable:
provider redundancy, a measurable ingestion loop, bounded storage, and the
diagnosability needed to run any of it unattended. It implements the operational
half of §118 (incremental indexer) and §121 (multi-chain). It adds no
intelligence, changes no score, and touches no analysis engine.

The safety property from D12 still holds:

> **`ENABLE_NETWORK_API=false` and `ENABLE_INDEXED_TRANSACTIONS=false` remain the
> defaults, and ingestion is still a CLI an operator starts. Nothing here changes
> an existing deployment.**

The one schema change is additive (indexes only).

---

## 1. What is and is not built

Built:

```text
provider rotation        INDEXER_RPC_URLS, several independent endpoints, with
                         per-endpoint spacing and cooldown
failure classification   transport / timeout / http / json, plus the provider's
                         own JSON-RPC code, recorded without endpoint URLs
measurable ingestion     per-batch indexed count, duration, cumulative total,
                         provider calls and distance behind the finalized head
deferred checks          network identity and archive floor on the first batch,
                         after a failure, then every N batches
bounded retention        operator network:prune, bounded by blocks AND rows,
                         with a reported floor and retention disclosure in the
                         read API
retention indexes        migration 0014
load harness             pnpm loadtest:network, deterministic, no provider
```

Not built, and unchanged from D12:

```text
table partitioning       considered and deferred, with the reasoning in §5
reputation score         still null: no labelled dataset, no calibrated model
on-chain $AEX            still internal bookkeeping only
EVM privacy analysis     still absent
```

## 2. Provider rotation

A single endpoint meant one provider outage stalled ingestion until it recovered,
because the daemon retried the same dead URL. The indexer now takes a list:

```sh
INDEXER_RPC_URLS=https://primary.example,https://secondary.example
```

A request that fails at the transport level, returns a non-2xx status or returns
unparseable JSON moves to the next endpoint and cools the failing one down. A
well-formed JSON-RPC rejection is an answer rather than an outage, so it does not
rotate away from a working provider — `-32015`, for instance, means the request
was wrong, not the endpoint.

Endpoint URLs never appear in logs, errors or statistics, because they routinely
carry an API key; statistics are keyed by configured position instead. Operator
knobs and their defaults are tabulated in `docs/network-operations.md`.

## 3. Measurable ingestion, and why the loop got cheaper

Every batch previously re-ran the network identity check and the archive-floor
check: two extra provider calls per batch for an answer that cannot change
between adjacent heights. A daemon now runs them on the first batch, after any
failure, and every `INDEXER_VERIFY_EVERY_BATCHES` batches. A single-clause
invocation keeps them always on, so the defensive tests still hold, and a steady
batch spends exactly `blocks + 2` provider calls.

Each batch now logs what an operator actually needs:

```json
{"event":"indexed","indexed":2,"nextHeight":447295297,"finalizedHeight":447295322,
 "rpcCalls":4,"batches":2,"indexedTotal":4,"behind":26,"durationMs":5633,
 "rpc":{"calls":10,"attempts":10,"endpointFailures":0,...}}
```

## 4. Bounded retention

Nothing removed indexed data, so storage grew without limit. Retention is now an
explicit operator command (`network:prune`) that removes blocks strictly below a
height and reports the floor it leaves behind. Work is bounded three ways — by
block count, by row count, and by a maximum number of batches — because blocks
are not uniform: a busy Solana block carries tens of thousands of address
memberships.

It takes no row lock on the checkpoint. Ingestion only appends at or above the
cursor while retention only removes below the bound, so the two cannot overlap,
and a prune can no longer stall a running indexer.

The read API states the retention floor as a limitation, including the case where
the index was populated and then pruned in full — which must not read as a wallet
that has never been used.

## 5. Defects found and fixed during the build

Every one of these was found by running the thing, not by reading it.

**Retention was unusable.** The first live prune never finished. Removing two
blocks from a 16-block sample (22,749 transactions, 320,042 memberships) took 53
seconds: deleting a transaction makes PostgreSQL check its child memberships, and
no index led with `(chain, tx_id)`, so every parent row scanned the child table.
Migration `0014` adds the three indexes retention deletes and foreign-key checks
need. The same prune over 22 blocks — 27,781 transactions, 340,910 memberships —
now takes 3.96 seconds.

**A failure told an operator nothing.** The first live attempt failed with
`kind=Error`, which does not distinguish a throttle from a timeout from a garbled
body. Failures now carry a fixed category and, for a rejection, the provider's own
code.

**An emptied index looked like an unused wallet.** Retention reported a floor only
while some blocks remained, so a fully pruned index disclosed nothing at all.
That is the exact case where silence is a false statement, and it is now explicit.

**The load harness had two defects, both found by running it.** It used top-level
await, which root-level tests cannot compile under tsx, and it imported
`@aegix/network` while the root workspace did not declare it.

**Signal handling is the caller's problem.** A `SIGTERM` sent to `pnpm` did not
reach the node process, so the daemon kept running and held its checkpoint lock.
In the container the image runs `node dist/cli.js` as PID 1, so signals arrive
directly; the verification harness now does the same. Worth knowing before
wrapping the indexer in another process manager.

## 6. Verified

Run on `projecteon-v2` on 2026-09-15, from a fresh clone with isolated PostgreSQL
16 and Redis 7. The running production stack was not touched.

```text
install --frozen-lockfile        PASS
typecheck / lint                 PASS
build (packages, apps, web)      PASS
unit tests                       PASS  (554 / 554; network package 22)
test:migrations                  PASS  (14 migrations)
test:network:operations          PASS
network package integration      PASS  (incl. row budget, emptied-index disclosure)
test:web-routing                 PASS
docker build indexer.Dockerfile  PASS
pnpm loadtest:network            PASS
```

Deterministic load harness (no provider involved, so these describe our code and
PostgreSQL): 192 blocks ingested in 1.47 s (130 blocks/s) at 1.09 provider calls
per block; 300 concurrent history reads at concurrency 16 completed in 253 ms
(1186 reads/s, p50 6 ms, p95 50 ms, 0 failures); 96 blocks pruned in 155 ms.

Bounded live run against `api.mainnet-beta.solana.com`, 90 seconds:

```text
blocks indexed        24 (12 batches of 2)
per batch             4.8-7.4 s
provider failures     0
behind at the end     248 heights and growing
storage               136 MB for 24 blocks (~5.7 MB per block)
                      30,637 transactions, 375,815 address memberships
```

That last line is the honest headline: over 90 seconds the public endpoint served
about 0.27 blocks per second while mainnet produces roughly 2.5, so the ingester
fell behind and would never catch up. D13 proves the loop works and measures it;
it does not make a free endpoint sufficient. A production deployment needs a
provider sized to the data, which is a procurement decision, not a code change.

## 7. Still open

```text
sustained ingestion      90 seconds is not a soak test; multi-hour behaviour
                         with a real provider is unmeasured
provider capacity        the public endpoint cannot keep up (see §6)
storage sizing           ~5.7 MB per block before projections means a retention
                         window must be chosen against real disk
partitioning             needs the table recreated and rows moved; retention
                         already bounds growth, so revisit when a measured
                         window no longer fits
rate-limit tuning        defaults are conservative; the load harness should set
                         them from measured headroom on the chosen provider
signature discovery      the analysis worker still discovers signatures over RPC
reputation model         needs a licensed labelled dataset and a calibration
tokenomics, EVM          unchanged from D12
```

D13 changes nothing about PR-11: credentials still need rotating, infrastructure
still needs provisioning, and nothing is deployed.
