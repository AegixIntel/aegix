#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to an allowlisted disposable test database}"
: "${RPC_URL:?Set RPC_URL to a Solana mainnet endpoint for program-catalog verification}"
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
# A program ID that decodes cleanly but has no on-chain account matches
# nothing, so the protocol it names silently disappears from every analysis.
# Only a live RPC can catch that, so it gates the release.
pnpm verify:programs
pnpm test:web-routing
pnpm test:web-restored
pnpm test:migrations
pnpm test:integration
pnpm test:queue-integration
pnpm test:e2e-d7
pnpm test:e2e-monitor
pnpm test:e2e-d6
pnpm test:e2e-d9
pnpm test:e2e-d10
pnpm test:e2e-d11
pnpm test:e2e-d11-revenue-safety
pnpm test:pipeline-wiring
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
