# Milestone D2 — Finalization: Load Validation, Entity Registry, Parser Coverage

Date: 2026-08-30

## D2 scope

D2 closes the reliability gap between "the system works" (D1) and "the system
survives realistic production behavior". Workstreams:

- A: data quality model v2 + calibrated confidence (`bc64a94`)
- B: multi-RPC provider pool + circuit breaker (`658dcfa`)
- C: observability + reliability (`c5d7668`)
- D: security hardening (`f0493d1`)
- E: load validation, entity registry v2, parser coverage (this milestone)

## Commits / workstreams included

```text
09f61db fix: golden wallet runner resolves workspace packages and passes logger
7c7067b feat: reusable analysis load-test harness
5738268 fix: reset failure fields on job retry and tolerate signature fetch errors
74feb6d feat: entity registry v2 with provenance and loud seed validation
e663116 feat: parser coverage expansion and semantic coverage metric
690e6aa feat: golden wallet suite expansion to 15 wallets with snapshots
```

## Load-test setup

`tests/load-test.ts` (script: `pnpm loadtest:analysis`). Flags: `--concurrency`,
`--count`, `--wallets`, `--timeout`, `--via-api`, `--same-wallet`,
`--cache-reuse`. `LOADTEST_INLINE=1` consumes jobs inline for deterministic
end-to-end timing. Infrastructure: Postgres + Redis via docker-compose,
Helius mainnet RPC.

## 5-concurrent results

`--concurrency=5 --count=5` (wallets: So111, Sysvar, Jupiter, Raydium AMM,
Raydium CLMM):

- 4 READY, 1 FAILED (INSUFFICIENT_HISTORY — Raydium AMM program account with
  no direct transfers; explainable, not an error)
- total wall 353.5s, avg queue wait 0s, avg worker 170.5s
- RPC failures rose under load: 49 → 235 across wallets; parser success
  stayed 100%

## 10-concurrent results

`--concurrency=10 --count=10` (10 distinct wallets: Metaplex, Orca v1,
Meteora DLMM, Marinade, Wormhole, Jupiter, Raydium CLMM, Pump.fun, Kamino,
user wallet):

- 6 READY, 4 non-ready: 2 INSUFFICIENT_HISTORY (program accounts),
  1 retried-then-succeeded (stale failure_code — bug found and fixed),
  1 stalled in NORMALIZING after fetch failure (bug found and fixed)
- total wall 397.5s, avg queue wait 28.6s, avg worker 115.2s
- RPC failures 156-456 per wallet — rate-limit bound under concurrency 10
- **Bugs found**: (1) `markStarted`/`markCompleted` never cleared failure
  fields, leaving READY jobs with stale INTERNAL_ERROR; (2)
  `fetchSignaturesPaged` threw on first 429 instead of skipping the page.
  Both fixed in `5738268`.

## Same-wallet dedup results

- 10 simultaneous requests, same fresh wallet (Orca): 1× 202 (job created),
  9× 409 ANALYSIS_IN_PROGRESS, 1 unique analysis ID — distributed lock works.
- 10 simultaneous requests, same cached wallet: 10× 200 cached, 1 unique ID,
  0 conflicts.
- 25 same-wallet requests (cached): all 200 cached, 1 unique ID.

## Cache results

After a completed analysis, 20 repeated requests: 20/20 cache hits, latency
4-9ms (vs 155ms for job creation), 0 new jobs, 0 RPC calls, 1 analysis ID.
Freshness-aware cache (`fresh_until` + Redis `analysis-result:`) is correct
under concurrency.

## CPU/RAM observations

- Worker: single analysis ~180-200s, mostly RPC-bound (fetch+normalize);
  engines/scoring/graph are single-digit ms
- Redis: 2.38M / 256M used, stable across load tests — no leak
- Postgres: 1-2 connections idle, no pool exhaustion
- No memory growth trend observed across repeated analyses

## Queue observations

- Queue wait ~0s at concurrency 5, ~28s at concurrency 10 (worker
  concurrency 3 = 3 slots for 10 jobs)
- BullMQ retry (attempts 3, exponential backoff) worked: retried jobs
  completed; stale failure state was the bug, now fixed
- DLQ inspection does not crash the worker

## Database observations

- `wallets` seq_scan 158k (table is 14 rows — full scan is trivial, no index
  needed)
- `transfers`/`program_interactions` (14k/141k rows) all hot paths indexed
- No slow queries identified at current scale; indexes only justified when
  tables grow by orders of magnitude

## RPC observations

- Sequential: 2-14 RPC failures per 1000-tx analysis
- Concurrency 5: 49-235 failures; concurrency 10: 156-456 failures
- Helius rate limit is the binding constraint; RPC failures are retried with
  backoff and never fail the analysis (page-skip tolerance added)

## Provider failover results

- Unit tests: failover to healthy secondary, circuit opens after threshold,
  half-open probe recovery, prefers fast measured provider
- Live test: dead primary (connection refused) → 1 request fails → pool
  fails over to Helius → analysis succeeds; circuit records errorRate,
  lastProvider switches
- Note: with a single configured provider (production default), failover has
  no second target — configure `RPC_SECONDARY_URL` for real failover

## Entity registry additions

11 entities / 13 addresses (from 6/7). Added with full provenance:

| Entity | Type | Status | Source |
| --- | --- | --- | --- |
| Metaplex | NFT_MARKETPLACE | VERIFIED | docs.metaplex.com |
| Orca (v1 + Whirlpools) | DEX | VERIFIED | docs.orca.so |
| Meteora DLMM | DEX | VERIFIED | docs.meteora.ag |
| Marinade | STAKING | VERIFIED | docs.marinade.finance |
| Wormhole | BRIDGE | VERIFIED | docs.wormhole.com |

All program IDs confirmed active on mainnet via RPC before seeding. No
exchange wallets, no community guesses.

## Entity provenance policy

Every seed entry carries: name, type, address, source (evidence URL),
verification status (VERIFIED/PROBABLE), confidence, first/last verified.
`validateSeedEntries()` rejects invalid addresses, duplicate program IDs,
conflicting VERIFIED ownership, missing source/evidence, confidence out of
range, invalid status. Seed loading fails loudly (exit code 1) on invalid
registry. 7 unit tests cover every rejection path.

## Parser additions

Driven by real observed frequency (program_interactions table):

- Raydium AMM v4 (`pAMMBay…`) — 4148 interactions
- Pump.fun fee account (`pfeeUxB…`) — 2276
- Metaplex Token Metadata — 1718 (entity + parser now aligned)
- Orca v1 + Whirlpools — 908+665
- Meteora DLMM — 1663 (was entity-only, now parsed)
- Marinade, Wormhole, Magic Eden v2

## Semantic coverage results

`ParseOutcome` now classifies FULLY_PARSED / PARTIALLY_PARSED /
GENERIC_PARSED / FAILED, and `semanticCoverage` (0-1) is aggregated into
`data_quality` on every job.

Real mainnet (15-wallet suite): parser success 100% everywhere, but semantic
coverage is honest and low for opaque protocols:

| Wallet | Semantic coverage |
| --- | --- |
| Metaplex | 8.4% |
| Sysvar clock | 16.6% |
| Pump.fun | 21.6% |
| So111 | 26.2% |
| Jupiter | 47.8% |
| Orca | 47.3% |
| Marinade | 54.2% |

Parser success and semantic coverage are deliberately not conflated.

## Golden-wallet results

15 wallets, 11 READY:

- Duration 183-201s per analysis (1000-tx bound)
- Score 25-43, confidence 0.82-0.86, signals 4-8, paths 0-10
- 4 FAILED INSUFFICIENT_HISTORY: fresh keypair + program accounts with no
  direct transfers (Raydium AMM, Kamino, Drift) — expected, explained
- RPC failures 2-14 sequential
- No score explosion; attack graph stays bounded (≤10 paths)

## Bugs discovered

1. Golden wallet runner: `processAnalysis` now requires a logger in
   `ProcessorContext`; runner was not updated → "Cannot read properties of
   undefined (reading 'child')" (fixed `09f61db`)
2. Root `package.json` had no `@aegix/*` workspace devDeps, so root-level
   test scripts could not resolve workspace packages (fixed `09f61db`)
3. `markStarted`/`markCompleted` never cleared failure fields → READY jobs
   with stale INTERNAL_ERROR after BullMQ retry (fixed `5738268`)
4. `fetchSignaturesPaged` threw on first 429 → whole analysis failed under
   load instead of skipping the page (fixed `5738268`)
5. Lockfile carried orphan `dev@0.1.5` dependency pulling `inotify` native
   build that breaks on this machine — removed from lockfile (not committed;
   environment fix)

## Bugs fixed

All four code bugs above fixed and verified by re-running the affected
paths (10-concurrent re-test, dedup re-test, DLQ test).

## Known limitations

- Semantic coverage for NFT/metadata protocols is low (Metaplex 8.4%) —
  inner-instruction action mapping needs deeper per-protocol work (D3)
- Program accounts (DEX/LENDING program IDs) legitimately report
  INSUFFICIENT_HISTORY because they hold no direct transfers — the
  pipeline could classify these as "protocol account" instead of failure
- Single-provider production default: failover only engages when a second
  RPC is configured
- 1000-tx cap keeps analyses at ~3 min; deeper history needs more RPC budget
- `fullyParsed` is 0 across real wallets — action mapping for real parsed
  instructions (as opposed to unit fixtures) is the next parser step

## Production bottlenecks

1. **RPC rate limit** — the binding constraint at concurrency ≥5. Helius
   free tier throttles ~4 concurrent fetches; worker concurrency above 3
   mostly queues on RPC, not CPU
2. **Worker concurrency 3 is reasonable** — raising it does not speed up
   analysis, it just increases RPC contention
3. **Semantic coverage** — most Solana transactions are still opaque
   generic records; intelligence quality is capped by parser depth

## Recommended worker concurrency

`ANALYSIS_WORKER_CONCURRENCY=3` (keep). Measured: at 5 concurrent jobs queue
wait is ~0s; at 10 it grows to ~28s but completes. Higher concurrency only
increases RPC 429s without reducing per-analysis time.

## Recommended RPC limits

- `ANALYSIS_RPC_CONCURRENCY=2` (default) — measured: 4 causes 3-10x more
  rate-limit failures; 2 keeps failures in single digits sequential
- `ANALYSIS_RPC_MIN_INTERVAL_MS=250` (default) — 120ms (dev .env) triples
  failures under load
- `ANALYSIS_MAX_TRANSACTIONS=1000` — balances depth vs wall-clock
- `ANALYSIS_MAX_SIGNATURE_PAGES=10` — matches 1000-tx budget
- `RPC_MAX_RETRIES=2` (default) — provider backoff already handles 429s
- `ANALYSIS_TIMEOUT_MS=600000` — 1000 tx takes 183-201s; 10 min is safe

## Recommended D3 scope

Prioritized by observed data:

1. Per-protocol instruction mapping for high-frequency programs (Jupiter,
   Raydium, Pump.fun) to raise semantic coverage above 50%
2. "Protocol account" classification for program IDs with no direct
   transfers (replaces INSUFFICIENT_HISTORY for known programs)
3. Multi-RPC failover configuration as a deployment default
4. Deeper history (2000+ tx) for high-value wallets once RPC budget allows
5. NFT marketplace parsing (Tensor, Magic Eden) — real frequency is rising

## D2 Definition of Done

- [x] real mainnet correctness (15-wallet suite, 11 READY)
- [x] concurrent stability (5/10 concurrent, dedup, cache tests)
- [x] provider failure tolerance (unit + live failover test)
- [x] traceable failures (structured logs, request_id/analysis_id/job_id)
- [x] verified DLQ (publish + inspect + classification test)
- [x] conservative entity intelligence (11 entities, provenance, validation)
- [x] improved semantic parsing (parseClass + semanticCoverage)
- [x] repeatable regression suite (45 tests + golden wallets + load harness)

All workspace typecheck / test / build pass.
