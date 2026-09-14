# AEGIX Public-Beta Production Readiness

Evidence date: 2026-09-11. This document describes the release candidate, not
a completed production deployment.

## Release decision and scope

Public beta requires wallet-only authentication and `IN_APP` notifications.
Email/SMTP is explicitly not required: production sets `EMAIL_ENABLED=false`
and `ENABLE_EMAIL_NOTIFICATIONS=false`. Existing optional email compatibility
remains isolated behind both flags. Webhook delivery remains supported when
enabled and configured.

No D8 or roadmap capability is part of this gate. Market/narrative
intelligence, anomaly/signal engines, AI Copilot, reputation, multi-chain, a
webhook consumer SDK, `$AEX`, and a global indexer remain future work.

Billing (D11 V1) is complete with manual subscription provisioning:
`BILLING_PROVIDER=manual`, users request an upgrade in the Billing UI and an
operator grants it with `pnpm billing:grant`; no payment-processor credentials
are required. Self-service checkout, a customer billing portal,
payment-provider webhooks and an automated payment lifecycle are post-launch
scope (`docs/milestone-d11.md` §6).

## Verification status

| Area | Status | Evidence |
|---|---|---|
| Local static/unit baseline | VERIFIED | `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` |
| PostgreSQL behavior | VERIFIED | API integration plus migration fresh/re-run/concurrency/D7-upgrade tests against PostgreSQL 16 |
| Redis/BullMQ behavior | VERIFIED | enqueue, consume, dedup, retry, terminal failure, DLQ, shutdown, and reconnect against Redis 7 |
| D7 functionality | VERIFIED | actual `test:e2e-d7` suite |
| Public-beta notifications | VERIFIED | actual `test:e2e-monitor`; wallet-only user with `email = NULL` receives `IN_APP`, with no email row/job |
| Deterministic intelligence | VERIFIED | wallet, classification, monitor, correlation, correlation-dataset, and correlation-block2 golden suites |
| Full `processAnalysis` wiring | VERIFIED | `pnpm test:pipeline-wiring` — real worker path against a local Solana JSON-RPC stub; engines, scoring, persistence and coverage disclosure all asserted on persisted output |
| Program catalog identity | VERIFIED | `pnpm verify:programs` — all catalog program IDs resolve to executable, loader-owned mainnet accounts |
| Container builds | VERIFIED | API, worker, web, and migration production Dockerfiles |
| Disposable backup/restore | VERIFIED | logical backup restored to a separate disposable database with schema/data checks |
| Real production deployment | NOT VERIFIED | No authorized target infrastructure or credentials were used |
| Real production backup/restore | BLOCKED | PENDING PRODUCTION INFRASTRUCTURE; procedure is documented and disposable rehearsal is complete |
| Email delivery | NOT REQUIRED FOR BETA | Feature remains disabled and SMTP is not required at startup |

Command counts and final outcomes belong in the release report accompanying
the release commit; rerun `pnpm release:gate` for a new candidate.

## Production topology

Use `docker-compose.production.yml`. It provides one migration job and the
minimum runtime services: PostgreSQL, Redis, API, worker, web, and nginx proxy.
Only the proxy publishes a host port. Database, Redis, API, worker, migration,
and web stay on the private network. API and worker cannot start until the
single migration job succeeds; the migration runner additionally uses a
PostgreSQL advisory lock for safety outside this topology.

TLS must terminate at a trusted edge before public traffic reaches the
reference proxy. Browser requests use same-origin `/api/*`. The development
`docker-compose.yml` is not a production deployment file.

## Production configuration

The table uses actual configuration names. Inject secrets only at runtime via
the deployment secret manager; never bake or print them.

### Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | API, worker, and migration PostgreSQL connection |
| `REDIS_URL` | API and worker Redis/BullMQ connection |
| `RPC_URL` | Solana RPC baseline endpoint |
| `PUBLIC_WEB_ORIGIN` | Compose source for `AUTH_DOMAIN`, `AUTH_APP_URI`, and `CORS_ORIGIN`; must be one HTTPS origin |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Required only for bundled PostgreSQL |
| `REDIS_PASSWORD` | Required only for bundled Redis |

Independent `RPC_PRIMARY_URL`, `RPC_SECONDARY_URL`, and
`RPC_TERTIARY_URL` providers are strongly recommended. A single provider is
valid but starts with an explicit degraded-resilience warning. Existing RPC
logic applies timeouts, bounded attempts, health tracking, and circuit breaking.

### Feature-gated

| Variable | Required when |
|---|---|
| `WEBHOOK_ENCRYPTION_KEY` | `ENABLE_WEBHOOK_DELIVERY=true`; minimum 32 characters |
| `SMTP_HOST` and related `SMTP_*` values | `EMAIL_ENABLED=true`; not used by public beta |
| Supabase variables | `ENABLE_LEGACY_AUTH=true`; public beta keeps legacy auth disabled |

### Optional tuning

Rate limits, request/body limits, worker concurrency, queue retention,
monitor scheduling/cooldown, RPC timeouts/circuit thresholds, and webhook retry
limits have validated bounded defaults in `packages/config/src/index.ts`.
Override only through reviewed deployment configuration. Keep
`WEBHOOK_DEV_ALLOW_PRIVATE=false` in production.

### Development only

`AEGIX_ALLOW_TEST_DB_RESET`, test database/host allowlists, local Supabase
defaults, test email providers, and localhost origins must never be present in
the production environment.

## Required public-beta flags

| Flag | Value | Effect |
|---|---:|---|
| `EMAIL_ENABLED` | `false` | No SMTP/provider startup dependency |
| `ENABLE_EMAIL_NOTIFICATIONS` | `false` | No email notification rows or jobs |
| `ENABLE_LEGACY_AUTH` | `false` | Wallet-only sessions |
| `ENABLE_NEW_ANALYSES` | normally `true` | Emergency admission kill switch |
| `ENABLE_MONITORING` | normally `true` | Monitor and in-app notification gate |
| `ENABLE_WEBHOOK_DELIVERY` | deployment choice | Requires encryption key only when true |

## Runtime, health, and shutdown

- `GET /health/live` is process liveness.
- `GET /health/ready` checks PostgreSQL, Redis, and queue viability. RPC outage
  is reported as degraded without leaking endpoints and does not cause a
  restart loop; core dependency loss returns 503.
- Worker health requires a fresh heartbeat written only after PostgreSQL,
  Redis/queue, consumers, and monitor scheduler readiness succeed.
- API SIGTERM stops new HTTP work, drains Fastify, and closes queues, Redis,
  and PostgreSQL. Worker SIGTERM stops heartbeat, drains consumers, and closes
  queues/database within the Compose grace period.
- Migration failures are visible as non-zero job exits. Per-file transactions
  prevent recording a failed migration as applied; the advisory lock is
  released explicitly or by PostgreSQL when the session ends.

## Observability and queue operations

Structured logs redact authorization, cookie, token, secret, full API-key, and
credential-bearing URL data while retaining non-secret key IDs/prefixes.
Health endpoints return dependency state without URLs, credentials, private
hostnames, or stack traces. Operators can inspect BullMQ counts using:

```bash
docker compose -f docker-compose.production.yml exec worker node dist/queue-status.js
```

The result includes `waiting`, `active`, `completed`, `failed`, and `delayed`
counts for every queue including dead-letter. Growing waiting/delayed counts,
failed jobs, stale worker heartbeat, provider circuit logs, webhook delivery
errors, and monitor processing errors are the minimum operational signals.
Response steps are in `docs/deployment-runbook.md`.

## Security release review

- Wallet challenge verification consumes challenges once and rejects replay,
  expiry, wallet mismatch, and invalid Ed25519 signatures.
- Resource queries scope saved analyses/comparisons, monitors, notifications,
  developer keys, and webhooks to the authenticated user.
- API-key scope and quota checks precede developer operations.
- Webhooks retain HMAC-SHA256 signing, timestamp/raw-body verification contract,
  redirect rejection, DNS/IP SSRF enforcement, bounded retries, auto-disable,
  and response caps.
- CORS uses one validated HTTPS origin; request/body and public/auth/developer
  rate limits remain bounded.
- Images contain no `.env` files or build-time secrets and run application
  processes as non-root users.

## Transfer parsing corrected against real `jsonParsed` field names

The pre-deployment wiring test drove `processAnalysis` end to end for the
first time — earlier E2E suites seeded repository rows and never executed the
worker's analysis path — and its fixture used the field names a real RPC
returns. Two parsers did not.

| Parser | Expected | `jsonParsed` actually sends | Effect |
|---|---|---|---|
| System transfer | `info.from`, `info.to` | `info.source`, `info.destination` | **every native SOL transfer silently dropped** |
| SPL token | `transfer`, `mintTo`, `burn` | `transferChecked` is the most frequent spl-token instruction on mainnet, ~2× the unchecked `transfer` | majority of token movement silently dropped |

Both were verified against finalized mainnet blocks before changing anything,
and both failed silently: no error, no parse failure, no unknown-program
count. The transfers table simply stayed empty, so the funding engine
reported `NO_INCOMING_FUNDING` for funded wallets, the counterparty engine
reported `NO_COUNTERPARTIES`, and amount-based transaction-pattern measures
had nothing to work with. Unit tests passed throughout because their fixtures
were written with the same wrong field names as the parser.

Both parsers now accept the shapes mainnet sends, keep accepting the legacy
fixture shape, and take the mint directly from the checked forms that carry
it. In the wiring test the same wallet went from 7 persisted signals to 10,
with `NO_INCOMING_FUNDING`/`NO_COUNTERPARTIES` replaced by `REPEATED_FUNDING`,
`FUNDING_CONCENTRATION`, `REPEATED_COUNTERPARTY`, `REPEATED_EXACT_AMOUNT` and
`LARGE_TRANSFER_OUTLIER`. Regression tests pin the real mainnet field names.

Normalizer throughput moved from 5µs to 6µs per transaction. The extra work
is the parsing that previously did not happen: the same benchmark produced 0
transfers before and 40,000 after.

## Engine and scoring version change

This candidate bumps two stamped versions, because the exposure score's
inputs changed:

| Constant | From | To | Where |
|---|---|---|---|
| `ANALYSIS_PIPELINE_VERSION` | `aegix-pipeline-v1.0.0` | `aegix-pipeline-v1.1.0` | `packages/types/src/version.ts` |
| `DEFAULT_SCORING_CONFIG.scoringVersion` | `score-v1.0.0` | `score-v1.1.0` | `packages/scoring/src/config.ts` |
| `SCORING_ENGINE_VERSION` | `scoring-v1.0.0` | `scoring-v1.1.0` | `packages/scoring/src/scoring.ts` |
| `PARSER_VERSION` | `normalizer-v1.0.0` | `normalizer-v1.1.0` | `packages/normalizer/src/types.ts` |
| `COMMONALITY_VERSION` | `population-commonality-v1.0.0` | `population-commonality-v1.1.0` | `packages/config`, `packages/commonality` |

The bump is required, not cosmetic. Three engines were added — transaction
pattern, public attribution and linkability — and two scoring components that
were previously stood in by a hard-coded `0` (`public_attribution`) and a
shared transaction-count proxy (`large_transfers`, `high_frequency`) now
receive measured values. Scores therefore move for reasons that have nothing
to do with the wallets.

**Operational consequence.** For every monitored wallet, the first
re-analysis after this deploy compares across a version change.
`computeComparability` in `@aegix/diff` marks the pair non-comparable, which
suppresses score-based monitor alerts (`PRIVACY_EXPOSURE_INCREASED`,
`IDENTITY_LINKABILITY_INCREASED`) and discounts confidence for that one
cycle. This is the intended behavior: without the bump, a scoring change
would have been delivered to users as a privacy exposure increase. Expect one
quiet monitor cycle per wallet after deploy, then normal alerting.

The API's analysis dedup lock is namespaced by the same pipeline version, so
in-flight locks from the previous version are not reused.

No migration is required. `exposure_signals.category` is free text with no
check constraint, so the three new signal categories insert without a schema
change, and no score dimension was added or removed.

## Release checklist

- [x] Production-hardening diff reviewed; unrelated `.commandcode/` and `front/` work excluded
- [x] Local typecheck, lint, unit, and build green
- [x] PostgreSQL integration green
- [x] Redis/BullMQ integration green
- [x] Migration fresh, re-run, concurrency, D7 upgrade, and data preservation green
- [x] D7 E2E green
- [x] Monitor/no-email E2E green
- [x] Deterministic golden suites green
- [x] API, worker, web, and migration images build
- [x] Production environment validation reviewed
- [x] Disposable backup/restore rehearsal green
- [x] Rollback, backup/restore, queue operations, and incidents documented
- [ ] Real infrastructure provisioned and secrets installed
- [ ] Real production backup/restore drill
- [ ] Real deployment and post-deploy smoke test

## Known public-beta limitations

- No global Solana indexer; transaction history is bounded by disclosed
  signature, transaction, RPC-call, history-day, and execution-time budgets.
- Entity registry and protocol/NFT semantic coverage are incomplete. Program
  identity is consolidated in a single verified catalog — see
  `docs/program-catalog.md` and `docs/intelligence-coverage-audit.md`.
  Instruction-level coverage remains partial for Raydium Router, Drift,
  Tensor Bid, and Pump.fun/PumpSwap. Bounded-sample percentages are not
  ecosystem-wide estimates.
- Population commonality activates only when the existing real-data
  sufficiency gate passes; a feature flag alone never enables the penalty.
- Email is not part of the required public-beta notification path.
