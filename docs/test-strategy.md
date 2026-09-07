# Test Strategy and Dependency Boundaries

The public-beta release gate separates deterministic unit work from tests that
need infrastructure. Every job uses a bounded timeout and owns its dependency
lifecycle.

| Class | Suites | Required dependencies | Release gate |
|---|---|---|---|
| Pure unit | package `*.test.ts`, API cursor/server unit tests, web API tests, worker heartbeat tests, test-environment guard tests | none | `pnpm test` |
| Database integration | API developer-key and notification route integration, migration concurrency/idempotency | isolated PostgreSQL | `pnpm test:integration`, `pnpm test:migrations` |
| Redis integration | enqueue, consume, deduplication, retry, terminal failure, DLQ, close, and reconnect | isolated Redis with `noeviction` | `pnpm test:queue-integration` |
| Deterministic golden | wallet fixtures, classification, monitors, correlation suites | PostgreSQL/Redis only where the runner needs them; no public RPC | all six `test:*` golden scripts |
| External/RPC smoke | legacy live wallet runner | live Solana RPC, potentially rate-limited | optional `pnpm test:wallets:live`; not a release gate |
| E2E | D7 public-beta, monitor/in-app notification, and D6 compatibility flows | unique PostgreSQL database plus Redis | `pnpm test:e2e-d7`, `pnpm test:e2e-monitor`, `pnpm test:e2e-d6` |
| Destructive/load | D5 and load runners | explicitly allowlisted disposable PostgreSQL database | manual/optional unless promoted |

All destructive runners call `tests/helpers/test-environment.ts` before opening
a connection. They require `NODE_ENV=test`,
`AEGIX_ALLOW_TEST_DB_RESET=true`, an exact allowlisted database name, and a
local or explicitly allowlisted CI host. Production is always rejected.

CI stores actual command output under `artifacts/` and uploads those files only
on failure. Database, Redis, Fastify, worker, queue, and local HTTP resources
must be closed in teardown; a timeout is a failure rather than an accepted
result.

Run the complete local sequence with `pnpm release:gate`. It refuses to start
unless `NODE_ENV=test`, `AEGIX_ALLOW_TEST_DB_RESET=true`, and explicit
disposable `DATABASE_URL` and `REDIS_URL` values are supplied.
