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

**Amended 11 October 2026**: production sets both flags and serves a bounded
window of finalized Solana blocks. The paragraph above is still true of the code,
and the measurement it shares is why the deployment stays bounded: 3.33 s per
block indexed against a head that moves at 2.5 blocks/s means a follower cannot
catch up, so the operator indexes a fixed range and stops.

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

---

## 8. Follow-up: sustained ingestion, and the payload PostgreSQL refuses

Run on 2026-09-16 on `projecteon-v2`, from a fresh tree, against an isolated
PostgreSQL 16 on a private port and the same public endpoint §6 measured. §7
called multi-hour behaviour with a real provider unmeasured. This is that run —
85 minutes, 725 batches — and it found a defect that stops ingestion
permanently.

### The defect

`network_blocks.raw` is `jsonb`. PostgreSQL cannot represent U+0000 inside
`jsonb`: an escape sequence in the JSON text decodes to a NUL code point, which
no text type can hold, and the insert is rejected with `unsupported Unicode
escape sequence` (SQLSTATE `22P05`). A `jsonParsed` envelope does carry them —
slot 425503014 has seven, in vote account seed fields.

The consequence is worse than one failed batch. The cursor only moves inside the
commit transaction, so the failing block is retried forever:

```text
2026-09-16 07:09:05 UTC [114] ERROR:  unsupported Unicode escape sequence
2026-09-16 07:09:05 UTC [114] DETAIL:  \u0000 cannot be converted to text.
2026-09-16 07:09:05 UTC [114] CONTEXT:  JSON data, line 1: ...","seed":"\u0018\u0000...
2026-09-16 07:09:05 UTC [114] STATEMENT:  insert into network_blocks (chain, ..., raw, raw_rpc) values ($1, ..., $6, $7)
```

Twenty-seven batches committed, then the daemon sat on height 425503014 for the
rest of the run. `behind` grew, `last_error` stayed `INDEX_BATCH_FAILED`, and an
operator could not tell why: the failure line carried `kind=PostgresError` and
nothing else. §5 fixed exactly this opacity for provider failures; a database
failure had been left without it.

### The fix

A NUL code point is recorded as U+FFFD in the JSONB projection, and the exact
RPC text is untouched in `network_blocks.raw_rpc`. Substitution happens at one
boundary (`jsonbSafe`, `packages/network/src/jsonb.ts`) and both writers use it:
the block row, and the projected transaction row, which has the same shape and
the same exposure.

A failure now carries its SQLSTATE, which is what tells an operator whether to
retry or to change code. The driver message is still never logged — it can quote
the row being written.

The regression tests assert the reason the guard exists rather than only its
behaviour: PostgreSQL genuinely rejects the payload, a NUL-bearing block commits
anyway, `raw_rpc` keeps the exact envelope, and the next block still commits.
The package integration suite is now wired into the CI integration job, because
a database-level write failure is invisible to unit tests — which is why this
survived D13.

Proof on the live daemon: restarted against the same checkpoint, the cursor left
the stuck height and never stalled again.

```text
next_height 425503014 (stuck, pre-fix)  ->  425503076 after three minutes, last_error cleared
```

### What 85 minutes of ingestion measured

```text
window                    85 minutes, 725 batches, 0 failed batches
blocks committed          1,450 (0.284 per second)
provider calls            2,926 (2.02 per block — the batch budget §3 claims)
batch duration            p50 4.6 s, p95 8.8 s, max 17.7 s (two blocks per batch)
heartbeat age             max 17 s; no stall, no restart, no error line
process RSS               239 MB at start, 366 MB at the end, 838 MB peak
distance behind the head  2 -> 14,673 (2.87 slots per second)
```

The loop is stable and bounded. The public endpoint is still the wall: mainnet
produces roughly 2.5 slots per second and the free endpoint served 0.284 blocks
per second, so the index fell behind by 172 slots a minute and would never
recover. §6 called that procurement; a sustained run confirms it as a measured
limit rather than a 90-second impression.

Memory is the other answer §7 wanted: RSS moved in a 239–838 MB band across the
85 minutes and ended below its midpoint, so nothing about this loop leaks on the
timescale an operator would notice.

### Retention under live ingestion

Three prunes ran against the live daemon:

```text
07:45  window 50   232 blocks   254,175 txs   2,162,227 memberships    49 s
08:01  window 60   312 blocks   333,401 txs   3,002,801 memberships    68 s
08:51  window 80   776 blocks   862,506 txs   9,410,732 memberships   166 s
```

Ingestion never stopped: the batch counter advanced through every prune
(141→154, 302→322, 700→715). That is §4's claim, now demonstrated under load
rather than argued from the absence of an overlap. Prune throughput is about
4.7 blocks per second, or 47,000 member rows per second.

Retention bounds the index, not the file. After the third prune the database
still occupied 14 GB holding 1.5 million live memberships and 9.4 million dead
tuples, and autovacuum's last pass predated the delete — the space was not yet
reusable. An operator sizing disk has to budget for reuse lag, not only for the
retained window. That is a measurement, not a defect, but it is narrower than
§7's wording ("retention already bounds growth") implies.

### Restart continuity

`SIGTERM` to the node process — never through `pnpm`, per §5 — at cursor
447,467,086 exited within 30 seconds, and the restart resumed from the stored
checkpoint: the next batch began at 447,467,086 and the cursor reached
447,467,108 with no gap and no discontinuity error. Integrity held across all
three prunes and the restart:

```text
orphaned memberships 0   orphaned transactions 0   blocks at or above the cursor 0
duplicate block hashes 0   blocks without a projection 0   cursor hash chain intact
```

### §7 after this run

```text
sustained ingestion      85 minutes measured: loop stable, RSS bounded, no stall
provider capacity        confirmed, not resolved — 0.284 blocks/s against ~2.5
                         slots/s produced. A paid provider is still procurement
signature discovery      unchanged
storage sizing           measured: ~10 MB per committed block with indexes, and
                         the file does not shrink when rows are pruned; size the
                         disk for the live window plus dead-tuple reuse
partitioning             unchanged, and still deferred: retention bounds live
                         rows, so revisit it when reuse lag binds instead
rate-limit tuning        unchanged: still needs measured headroom on the chosen provider
reputation model         unchanged
tokenomics, EVM          unchanged
```

D13 still changes nothing about PR-11.

