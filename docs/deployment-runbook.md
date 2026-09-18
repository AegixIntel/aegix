# AEGIX Public-Beta Deployment Runbook

This runbook operates the reference single-replica Compose topology. It is not
a rolling deployment and may incur brief downtime. Replace example domains and
image tags with the reviewed target values; never invent or expose credentials.

## 1. Prerequisites

- Docker Engine with Compose v2, sufficient disk for four application images,
  and access to the approved image registry if images are pulled.
- PostgreSQL 16 and Redis 7, either private managed services or the bundled
  Compose services. Redis must use `noeviction`.
- A trusted HTTPS edge/load balancer forwarding to the proxy; the reference
  nginx service itself listens on HTTP.
- A secret manager or root-readable deployment environment file outside the
  repository. Do not put secrets in shell history, Compose YAML, image build
  arguments, logs, tickets, or committed `.env` files.
- A Solana RPC endpoint; independent primary and fallback providers are
  strongly recommended.
- For source verification: Node.js 22 and pnpm 9 as declared by the repository.

Use `docs/production-readiness.md` as the authoritative variable and feature
flag inventory. Public beta must keep email and legacy auth disabled.

## 2. Provision infrastructure and secrets

Create the database and least-privilege runtime/migration credentials according
to the platform policy. Keep PostgreSQL and Redis private. If the bundled
services are used, supply all `POSTGRES_*`, `REDIS_PASSWORD`, `DATABASE_URL`,
and `REDIS_URL` values consistently. Prefer managed TLS URLs where supported.

Set `PUBLIC_WEB_ORIGIN` to the exact public HTTPS origin; it binds CORS and the
wallet-signature domain. Set `RPC_URL` and optional independent
`RPC_PRIMARY_URL`, `RPC_SECONDARY_URL`, and `RPC_TERTIARY_URL`. When webhooks
are enabled, provision a 32+ character `WEBHOOK_ENCRYPTION_KEY`; when disabled,
the key may be absent. SMTP is not required when email flags are false.

Validate interpolation with dummy values only. Do not run `docker compose
config` where its output could expose real secrets.

## 3. Preflight and release gate

On a candidate checkout, run the complete gate against disposable PostgreSQL
and Redis instances—not production:

```bash
NODE_ENV=test \
AEGIX_ALLOW_TEST_DB_RESET=true \
DATABASE_URL='<disposable-test-database-url>' \
REDIS_URL='<disposable-test-redis-url>' \
pnpm release:gate
```

The script validates dependency integrity, typecheck, lint, unit/build,
PostgreSQL and Redis integration, migrations, D7/monitor/D6 E2E, deterministic
goldens, all four images, and `git diff --check`. It fails closed if the test
database reset guard is absent. Review the image digest/tag and staged diff;
do not deploy a candidate with a skipped required gate.

## 4. Backup before migration

Use an encrypted provider snapshot when available. For self-hosted PostgreSQL,
supply credentials through a protected `.pgpass`/service file or secret-mounted
environment and create a custom-format logical backup:

```bash
pg_dump --format=custom --file='<protected-backup-path>' '<database-url>'
pg_restore --list '<protected-backup-path>'
```

Record the snapshot/backup identifier, timestamp, database server version,
application commit, and restore owner. Test restoration into a separate private
database before relying on the backup. Never overwrite the live database to
test restoration.

## 5. Build or pull images

Prefer immutable registry digests produced by the verified CI release gate. If
building on the target host:

```bash
docker compose -f docker-compose.production.yml build migrate api worker web
```

The Dockerfiles accept no secret build arguments. Web build arguments are
limited to `/api`, the private build-time API address and the public site
origin.

## 6. Migrate and start

For bundled dependencies:

```bash
docker compose -f docker-compose.production.yml up -d postgres redis
docker compose -f docker-compose.production.yml run --rm migrate
docker compose -f docker-compose.production.yml up -d api worker web proxy
```

For a single host that terminates TLS itself, layer the HTTPS edge
(`docker-compose.edge.yml`, Caddy with automatic Let's Encrypt certificates,
`www` redirected to the apex). It narrows the proxy port to loopback and trusts
two proxy hops for client IPs. The domain and `www` must resolve to the host and
ports 80/443 must be reachable. `PUBLIC_WEB_ORIGIN` is also baked into the web
build for canonical URLs and the sitemap, so rebuild `web` when it changes.

```bash
C="docker compose -p aegix -f docker-compose.production.yml -f docker-compose.edge.yml --env-file <protected env file>"
$C build migrate api worker web
$C up -d postgres redis
$C run --rm migrate
$C up -d api worker web proxy edge
```

For managed PostgreSQL/Redis, use the platform-specific Compose override or
orchestrator configuration; do not invent duplicate database services. Run one
dedicated migration job before application rollout. The runner is re-runnable,
holds a PostgreSQL advisory lock, wraps each migration in a transaction, and
exits non-zero on failure. API/worker must not be released when migration fails.

## 7. Health and smoke verification

Against the actual public HTTPS origin:

```bash
curl --fail --silent --show-error '<public-origin>/api/health/live'
curl --fail --silent --show-error '<public-origin>/api/health/ready'
curl --fail --silent --show-error --output /dev/null '<public-origin>/'
```

Inspect bounded logs and the worker probe:

```bash
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml exec worker node dist/healthcheck.js
docker compose -f docker-compose.production.yml logs --tail=100 migrate api worker
```

Complete the real user smoke journey: landing, wallet challenge/signature and
session, Wallet X-Ray analysis, save, monitor creation, compare, and notification
inbox. Trigger a controlled meaningful monitor event and verify an `IN_APP`
notification for a wallet-only account with no email. Verify read-one/read-all.

For the developer surface, create a short-lived scoped API key, call one
authorized intelligence endpoint, verify metering/quota, revoke it, and confirm
reuse is rejected. Record only its ID/prefix, never the full key.

For webhooks, register only an approved controlled endpoint, trigger an event,
verify the timestamped HMAC-SHA256 signature against the raw body, then remove
the endpoint. Never weaken SSRF policy or target arbitrary third parties.

## 8. Queue operations and observability

```bash
docker compose -f docker-compose.production.yml exec worker node dist/queue-status.js
```

Inspect `waiting`, `active`, `completed`, `failed`, and `delayed` for analysis,
monitoring, notifications, webhooks, and dead-letter queues. A rising waiting
count with no active work usually means worker/readiness failure. Rising active
with low completion suggests slow DB/RPC work. Rising delayed is expected only
within retry/backoff bounds. Any failed or DLQ increase requires sampling job
IDs and redacted error codes from structured logs; do not dump payloads that
may contain sensitive data.

Operators must also watch API/worker health, PostgreSQL connections/storage,
Redis memory and evictions, worker heartbeat age, provider circuit/failover
logs, monitor failures, and webhook delivery/auto-disable events.

## 9. Rollback

1. Stop or gate new analysis/monitor writes when data compatibility is unclear.
2. Retain current logs and take an incident snapshot before changing state.
3. Redeploy the prior immutable application images only if they are compatible
   with the migrated schema.
4. For an incompatible forward-only migration, restore the pre-deploy backup
   into a new database, validate migrations/schema/data privately, then switch
   `DATABASE_URL` during a controlled restart.
5. Run health and the full smoke journey again.

Never improvise destructive down-migrations or restore over the live database.

## 10. Restore procedure

Restore into a new isolated database owned by the intended runtime role:

```bash
createdb '<new-database-name>'
pg_restore --exit-on-error --no-owner --dbname='<new-database-url>' '<protected-backup-path>'
```

Verify the `schema_migrations` versions, required indexes, row-count invariants,
wallet ownership boundaries, and a read-only application smoke. Then either
promote the restored database using the provider mechanism or update the secret
and restart migration/API/worker in order. Keep the old database read-only until
the recovery window closes. Real production restore remains **PENDING
PRODUCTION INFRASTRUCTURE** even though this sequence is rehearsed against a
disposable database during the release gate.

## 11. Incident quick reference

| Incident | Symptom / first check | Safe mitigation | Recovery evidence |
|---|---|---|---|
| RPC outage | Readiness degraded; provider circuit/failure logs | Confirm bounded failover; switch/rotate provider configuration, or disable new analyses if all providers fail | Primary/fallback probes and one bounded analysis succeed |
| Redis outage | API readiness 503, stale worker heartbeat, queues unavailable | Stop worker restarts if storming; restore private Redis, preserving AOF/managed backup | Redis ping, worker health, queue counts, and a controlled job succeed |
| Database unavailable | API readiness 503; SQL connection errors | Stop writers, check provider/storage/connections, fail over or restore to a new DB | Migration status, integrity queries, health and smoke pass |
| Worker crash loop | Stale heartbeat; repeated container exits | Inspect first startup error, scheduler/Redis/DB state; do not delete jobs; correct config then restart one worker | Stable heartbeat and waiting queue drains without duplicate effects |
| Migration failure | Migration job non-zero; API/worker blocked | Keep application stopped, preserve SQL/error logs, fix the smallest migration issue or restore pre-migration backup | Migration succeeds twice; schema/data checks pass |
| Queue backlog | Waiting/delayed increases while completion stalls | Gate new analyses if necessary; identify dependency bottleneck; scale only after correctness checks | Waiting declines, completion grows, failed/DLQ stays bounded |
| Webhook failure storm | Retry/failed/DLQ and auto-disable events rise | Disable webhook delivery globally if needed; investigate controlled endpoints and network policy | Controlled signed delivery succeeds; retry counts normalize |

Record incident times, commit/image digests, affected queues/providers, feature
flag changes, mitigation, and recovery evidence. Exclude credentials, full API
keys, signed URLs, authorization headers, payload secrets, and stack traces from
public reports.

## 12. Manual billing operations (V1)

V1 provisions paid plans manually (`BILLING_PROVIDER=manual`). There is no
self-service checkout and no payment processor to reconcile against, so the
operator is the payment system. Every command below runs the same state machine
and appends the same `billing_events` entry as any other transition — none of
them is a database edit, so the ledger stays a complete history of how each
subscription reached its state.

Run them with the target database in scope: the script reads `DATABASE_URL`, so
confirm which database that points at before acting. Do not improvise SQL
instead of these commands.

```bash
pnpm billing:grant -- --requests                      # open upgrade requests
pnpm billing:grant -- --user <uuid> --show            # subscription, open request, recent ledger
pnpm billing:grant -- --user <uuid> --plan pro        # grant (or change to) a paid plan
pnpm billing:grant -- --user <uuid> --action CANCEL   # end at period end
pnpm billing:grant -- --user <uuid> --action CANCEL_IMMEDIATELY   # end now
pnpm billing:grant -- --user <uuid> --action RESUME   # revoke a scheduled cancellation
pnpm billing:grant -- --user <uuid> --action PAYMENT_FAILED
pnpm billing:grant -- --user <uuid> --action PAYMENT_RECOVERED
pnpm billing:grant -- --user <uuid> --action EXPIRE
pnpm billing:grant -- --invoice <id> --mark-paid      # confirmed payment: OPEN -> PAID, one more period
```

### Routine

- **Check pending upgrade requests at least once a day** (`--requests`). Nothing
  notifies you: a request is intent only and creates no subscription, so it waits
  until an operator acts on it.
- Confirm the payment **outside** AEGIX (see §13 for the method the operator must
  define first), then grant the plan. A grant answers the identity's open request.
- When a paid period's invoice is raised `OPEN`, confirm payment and settle it
  with `--mark-paid`.

### Behaviour that matters when something goes wrong

- **A manual subscription never renews on the clock.** When its period elapses
  unpaid it expires, entitlements return to free, and the closed period is
  invoiced `OPEN` so it stays collectible. Only `--mark-paid` starts the next
  period.
- **`--mark-paid` is idempotent.** The invoice id is the ledger event key, so a
  replayed command reports "already settled" and extends nothing. A `VOID` or
  unknown invoice is refused.
- **Nothing is deleted.** Monitors beyond the free level move to
  `ENTITLEMENT_PAUSED` and return to `ACTIVE` when a paid period resumes; a
  monitor the owner paused themselves is never touched.
- **If a payment is disputed or charged twice**, `--show` gives the ledger entry
  and the invoice, and `--action PAYMENT_FAILED` moves the subscription to
  `PAST_DUE` for the grace window. Do not fix a billing mistake by editing rows.

## 13. Paid-plan payment method (operator decision — OPEN)

AEGIX V1 has no payment processor, and this runbook deliberately does not invent
one. Before any paid plan is sold, the operator must record, in this section:

- accepted payment method(s);
- the destination account/wallet that receives payment;
- currency or asset;
- how an incoming payment is matched to an upgrade request (which identifier);
- when entitlement is granted relative to receipt;
- how refunds and chargebacks are handled.

Until that is written down, **paid-plan sales are blocked**: the Free plan runs
normally, but nothing here supports collecting money, so `--plan pro` must not be
granted in exchange for payment that the operator has not defined how to accept.
