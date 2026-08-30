# Milestone D1 — First Real End-to-End Wallet Analysis

Date: 2026-08-30

## What was changed

- **Worker pipeline** (`apps/worker/src/processors/analysis.ts`):
  - Persists signals, exposure scores and attack paths to PostgreSQL
    (previously only job status was stored)
  - Paginated signature fetching (bounded pages) and bounded parallel
    transaction fetching with per-request timeout and retry budget
  - Per-transaction failure tolerance: one bad transaction never fails the
    whole analysis; failures are counted and reported in data quality
  - Entity registry loaded from the database instead of an empty constant
  - Data-quality metrics persisted on the job (requested/received/parsed,
    parser failures, RPC failures, unknown programs, history range)
  - `job.log` wrapped so logging can never crash the pipeline
- **RPC provider** (`packages/blockchain/src/solana/provider.ts`):
  - `getTransaction` now calls `getTransaction` with `encoding: jsonParsed`
    directly, because some gateways (including the Helius endpoint used for
    this milestone) reject the `getParsedTransaction` method
  - Bounded retries with exponential backoff on 429/timeouts, per-request timeout
- **Normalizer** (`packages/normalizer`):
  - Handles inner instructions, missing blockTime, wrapped SOL, versioned
    transactions; returns a `ParseOutcome` with failure reason and unknown
    program count instead of throwing
  - SPL amount resolution from token balance metadata
- **Database**:
  - `intelligence` repository (signals, scores, paths) and
    `entity-registry` repository
  - Entity seed script (`pnpm --filter @aegix/database seed:entities`) with
    documented protocol program IDs only (Jupiter, Raydium, Pump.fun, Kamino,
    Drift, OpenBook) — no invented exchange wallets
  - Migration fixes: `analysis_jobs` timestamps, `entities.name` unique
  - `undefined` values sanitized at the DB boundary (postgres.js rejects them)
- **API** (`apps/api/src/server.ts`):
  - Distributed analysis lock (`analysis-lock:{chain}:{wallet}:{scope}:{engine}`)
    — concurrent duplicate requests return the same job
  - Freshness-aware cache (checks `fresh_until` before returning cached results)
  - Wallet X-Ray endpoint `GET /v1/wallets/:address/x-ray` with score,
    dimensions, top signals + evidence + explanations, coverage and attack paths
  - Security headers (nosniff, frame deny, referrer policy)
- **Explanation engine** (`packages/explanation`): deterministic,
  template-based, neutral-language explanations; no LLM required
- **Web** (`apps/web`): Wallet X-Ray page at `/analyze/[wallet]` with header,
  primary score, seven dimensions, top findings, evidence explorer and
  Attack My Wallet paths
- **Tests**: golden wallet runner (`pnpm test:wallets`), explanation engine
  tests, updated normalizer tests

## What was tested

Real Solana mainnet via Helius RPC (`mainnet.helius-rpc.com`).

| Wallet | Category | Result |
| --- | --- | --- |
| `H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a` | NEW_WALLET (fresh keypair) | `FAILED / INSUFFICIENT_HISTORY` — correct handling |
| `SysvarC1ock11111111111111111111111111111111` | SYSTEM_ACCOUNT (high activity) | READY — 293 tx, 34 transfers, 1274 program interactions, 5 signals, score 33, confidence 0.64 |
| `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | PROTOCOL_ACCOUNT (Jupiter v6) | READY — 234 tx, 5 signals, score 35 |
| `So11111111111111111111111111111111111111112` | TOKEN_MINT (Wrapped SOL) | READY — 243 tx, score 34 |
| `7iDEKWJMprnBCLj8ZnSJxxa9TvMN83YCzrqpAU4Sp9KU` | REPEATED_COUNTERPARTY | READY — 291 tx, REPEATED_FUNDING severity 80, **10 attack paths** |

All analyses reported parser success rate 100%.

Verified behaviors:

- Deduplication: 3 concurrent requests for the same wallet produced one job
- Cache: fresh analyses returned without creating duplicate jobs
- Entity matching found real protocol interactions (Jupiter, Raydium) from
  the seeded registry
- Confidence is independent of exposure (e.g. score 33 / confidence 0.64)
- Explanations use neutral language ("may increase wallet linkability",
  never "same person")
- CORS verified for the web frontend; security headers present

## Known limitations

- **Public RPC rate limits**: the default `api.mainnet-beta.solana.com`
  throttles hard (429). A Helius (or similar) key is effectively required.
- **1-hop attack graph**: attack paths are built from the target wallet's
  own transfers; multi-hop expansion requires analyzing neighboring wallets
  (not implemented — intentionally out of scope for D1).
- **History depth**: bounded by `ANALYSIS_MAX_TRANSACTIONS` (default 2000)
  and `ANALYSIS_MAX_SIGNATURE_PAGES` (default 5); reports state coverage.
- **Unknown programs**: counted in data quality but not classified
  (986 unknown program interactions on SysvarC1ock).
- **No exchange wallets in the entity registry** (deliberate — weak
  attribution must not become fact).
- **Analysis time**: a 300-transaction analysis takes roughly 1–3 minutes
  depending on RPC latency.

## Remaining TODOs

- Structured logging with request_id/job_id correlation in the worker
- Dead-letter queue wiring verification (BullMQ DLQ exists; jobs currently
  fail in place with attempts exhausted)
- `@fastify/helmet` or explicit CSP headers
- Load test at 5/10 concurrent analyses
- Seed a broader, responsibly-sourced entity registry
- Parser coverage for more protocols (Metaplex, Tensor, etc.)
