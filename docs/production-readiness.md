# AEGIX Public-Beta Production Readiness

Evidence date: 2026-09-08. This document describes the release candidate, not
a completed production deployment.

## Release decision and scope

Public beta requires wallet-only authentication and `IN_APP` notifications.
Email/SMTP is explicitly not required: production sets `EMAIL_ENABLED=false`
and `ENABLE_EMAIL_NOTIFICATIONS=false`. Existing optional email compatibility
remains isolated behind both flags. Webhook delivery remains supported when
enabled and configured.

No D8 or roadmap capability is part of this gate. Market/narrative
intelligence, anomaly/signal engines, AI Copilot, reputation, billing,
multi-chain, a webhook consumer SDK, `$AEX`, and a global indexer remain future
work.

## Verification status

| Area | Status | Evidence |
|---|---|---|
| Local static/unit baseline | VERIFIED | `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` |
| PostgreSQL behavior | VERIFIED | API integration plus migration fresh/re-run/concurrency/D7-upgrade tests against PostgreSQL 16 |
| Redis/BullMQ behavior | VERIFIED | enqueue, consume, dedup, retry, terminal failure, DLQ, shutdown, and reconnect against Redis 7 |
| D7 functionality | VERIFIED | actual `test:e2e-d7` suite |
| Public-beta notifications | VERIFIED | actual `test:e2e-monitor`; wallet-only user with `email = NULL` receives `IN_APP`, with no email row/job |
| Deterministic intelligence | VERIFIED | wallet, classification, monitor, correlation, correlation-dataset, and correlation-block2 golden suites |
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

- No global Solana indexer; transaction history is bounded.
- Entity registry and protocol/NFT semantic coverage are incomplete.
- Population commonality activates only when the existing real-data
  sufficiency gate passes; a feature flag alone never enables the penalty.
- Email is not part of the required public-beta notification path.
