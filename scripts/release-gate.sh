#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to an allowlisted disposable test database}"
: "${REDIS_URL:?Set REDIS_URL to a disposable test Redis instance}"
: "${AEGIX_ALLOW_TEST_DB_RESET:?Set AEGIX_ALLOW_TEST_DB_RESET=true}"

if [[ "${NODE_ENV:-}" != "test" || "$AEGIX_ALLOW_TEST_DB_RESET" != "true" ]]; then
  echo "Release gate requires NODE_ENV=test and AEGIX_ALLOW_TEST_DB_RESET=true" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:web-routing
pnpm test:migrations
pnpm test:integration
pnpm test:queue-integration
pnpm test:e2e-d7
pnpm test:e2e-monitor
pnpm test:e2e-d6
pnpm test:wallets
pnpm test:account-classification
pnpm test:monitors
pnpm test:correlation
pnpm test:correlation-dataset
pnpm test:correlation-block2
docker build -f infra/docker/api.Dockerfile -t aegix-api:release-gate .
docker build -f infra/docker/worker.Dockerfile -t aegix-worker:release-gate .
docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=/api -t aegix-web:release-gate .
docker build -f infra/docker/migrate.Dockerfile -t aegix-migrate:release-gate .
git diff --check
