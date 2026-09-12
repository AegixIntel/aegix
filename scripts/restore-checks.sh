#!/usr/bin/env bash
set -uo pipefail
: "${DATABASE_URL:?Disposable test database required}"
: "${REDIS_URL:?Disposable test Redis required}"
if [[ "${NODE_ENV:-}" != "test" || "${AEGIX_ALLOW_TEST_DB_RESET:-}" != "true" ]]; then
  echo "Restore checks require NODE_ENV=test and AEGIX_ALLOW_TEST_DB_RESET=true" >&2
  exit 1
fi
result_dir="${AEGIX_RESTORE_LOG_DIR:-/tmp/aegix-restore-results}"
mkdir -p "$result_dir"
failed=0
run() {
  local target="$1"
  echo "RUN $target"
  if pnpm "$target" > "$result_dir/${target//:/-}.log" 2>&1; then
    echo "PASS $target"
  else
    echo "FAIL $target"
    tail -25 "$result_dir/${target//:/-}.log"
    failed=1
  fi
}
run typecheck
run lint
run test
run build
run test:web-routing
run test:web-restored
run test:migrations
run test:integration
run test:queue-integration
run test:e2e-d5
run test:e2e-d6-block1
run test:e2e-d6-block2
run test:e2e-d6
run test:e2e-d7
run test:e2e-monitor
run test:pipeline-wiring
run test:e2e-d9
run test:e2e-d10
run test:wallets
run test:account-classification
run test:monitors
run test:correlation
run test:correlation-dataset
run test:correlation-block2
exit "$failed"
