# Milestone D4 — Privacy Threat Monitor

Date: 2026-08-31

## D4 scope

Turn AEGIX from a point-in-time wallet analyzer into a continuously
monitoring privacy threat system. A user registers a monitor on a saved
wallet; the system re-analyzes on schedule, diffs the new observation
against the previous one, derives evidence-backed threat events, applies
alert rules (severity/confidence floors, cooldown, hysteresis), and
delivers notifications.

- D4-A: Privacy monitor domain model (migration, types, repos, config, API)
- D4-B: Scheduled re-analysis (scheduler sweep, per-monitor runs, freshness reuse)
- D4-C: Exposure diff engine (scores, signals, entities, relationships, attack paths)
- D4-D: Threat event engine (candidates from diff evidence, severity/confidence)
- D4-E: Alert rules (per-type toggles, floors, cooldown, hysteresis)
- D4-F: Notifications (in-app + email, idempotency keys, delivery worker)
- D4-G: Monitor dashboard + exposure timeline
- D4-H: Notifications inbox + noise suppression knobs
- D4-I: Health integration + resource budgets (kill switch, hourly caps)
- D4-J: Regression hardening, golden tests, load testing

## Commits

```text
e782933 feat: D4-A privacy monitor domain model (migration, types, repos, config, API)
774c231 feat: D4-B/C/D/E/F scheduled re-analysis, diff engine, threat events, alert rules, notifications
ed35364 feat: D4-G/H/I monitor dashboard, notifications inbox, noise suppression knobs, health
b888d4b feat: D4-J regression hardening — snake_case entity type fix, hysteresis last-event, golden monitors + load test
```

## Domain model (D4-A)

New tables (migration `0003_d4_privacy_monitor.sql`):

- `privacy_monitors` — one per (user, wallet), status
  ACTIVE|PAUSED|DEGRADED|ERROR|DISABLED, schedule DAILY/EVERY_12_HOURS/
  EVERY_6_HOURS, tracks `baseline_analysis_id` and `last_analysis_id`
- `monitor_checks` — audit trail for every scheduled run
  (PENDING|IN_PROGRESS|COMPLETED|REUSED|DELAYED|FAILED, delay_ms)
- `exposure_diffs` — structured comparison between two analyses, unique
  per (monitor, previous, current) pair → idempotent fan-out
- `threat_events` — evidence-backed findings, unique per
  (monitor, fingerprint) → cooldown/dedup anchor, OPEN|ACKNOWLEDGED|
  RESOLVED|EXPIRED lifecycle
- `monitor_alert_rules` — 1:1 with monitor, safe defaults
- `notifications` — delivery records with idempotency key + status guard

RLS on all user-owned tables; alerts/checks/diffs scoped through monitor
ownership. API endpoints under `/v1/monitors`, `/v1/monitors/:id/events`,
`/v1/notifications` (see `apps/api`).

## Scheduling (D4-B)

- Worker `monitoring` queue with a sweep job (`*/5 * * * *`) that lists
  due monitors and enqueues deterministic per-window runs
  (`monitor:{id}:{window}` job id → duplicate window is a no-op)
- Per-monitor run reuses a fresh READY analysis when possible
  (freshness = max(MONITOR_FRESHNESS_TTL_SECONDS,
  ANALYSIS_CACHE_TTL_SECONDS)) — never spends RPC twice when the user
  just analyzed the wallet; otherwise enqueues a low-priority `free`
  analysis so interactive requests stay prioritized
- Hourly budget gate (MAX_MONITOR_JOBS_PER_HOUR) before sweeping
- Analysis-complete fan-out: `analysis` processor enqueues
  `monitor-diff` per wallet; the pipeline is best-effort and per-monitor
  isolated (one failing monitor cannot block the others)

## Diff engine (D4-C)

`packages/diff/src/index.ts` — pure functions over persisted rows
(source of truth, never client input):

- `diffScores` — per-dimension delta; dimension keys are exposed
  camelCase to consumers
- `diffSignals` — canonical semantic identity (signal type + evidence
  subject/counterparty/entity, never row id) so confidence/severity
  changes keep identity; reorder alone is not a change
- `diffEntities` — derived from KNOWN_ENTITY_INTERACTION signals;
  entity type read from evidence key `entity_type` (the engine emits
  snake_case) with camelCase tolerance
- `diffAttackPaths` — path identity is the sorted set of node labels,
  so a node reorder is not a new path (D4-C §28)
- `assessDataQualityChange` — coverage drop is flagged as
  DATA_QUALITY_DEGRADED, never read as exposure reduction
- `computeComparability` — engine/scoring version drift makes score-based
  events unreliable (confidence halved, score events suppressed)
- Diff confidence combines evidence count + score magnitude + comparability

## Threat events (D4-D)

`packages/monitor/src/threat.ts`:

- Difference is not threat: every candidate maps back to evidence in the
  diff. Severity derives from evidence (entity type, interaction count,
  path strength, score bands), never from a raw delta alone
- Event types: PRIVACY_EXPOSURE_INCREASED, IDENTITY_LINKABILITY_INCREASED,
  NEW_ENTITY_EXPOSURE, NEW_REPEATED_FUNDER, NEW_ATTACK_PATH,
  BEHAVIORAL_FINGERPRINT_STRENGTHENED, DATA_QUALITY_DEGRADED
- Fingerprints are stable semantic identities per (monitor, event type,
  subject) — duplicate fan-out cannot duplicate events
- Score-increase events are suppressed entirely on engine version drift;
  entity events survive with discounted confidence

## Alert rules (D4-E)

`applyRules` is a pure decision function (thresholds, confidence floor,
per-type toggles, cooldown, hysteresis) returning reasons so they can be
persisted:

- Severity floor (minimum_severity), confidence floor
  (minimum_confidence), score delta threshold for score-based events
- Per-type toggles: notify_new_entity, notify_new_attack_path,
  notify_behavior_change, notify_data_quality_degraded
- Cooldown (D4-H §64): same fingerprint within cooldown_hours window →
  suppressed
- Hysteresis (D4-H §65): for score-increase events, a repeated increase
  must exceed the previous increase of the same event, else it is
  oscillation (49 → 51 → 49 → 51). Compared against the last event of
  the same fingerprint regardless of window — a repeat after cooldown
  expiry still needs to exceed the previous delta, not just clear the
  cooldown

## Notifications (D4-F)

- In-app notification per (fingerprint|channel) with sha256 idempotency
  key — retries can never duplicate
- Email notifications gated by ENABLE_EMAIL_NOTIFICATIONS; delivery via
  the `deliver` queue job with attempt cap and status guard
  (PENDING→SENT|FAILED|SUPPRESSED)
- Unread count + read/acknowledge lifecycle on events

## Dashboard + inbox (D4-G/H)

- Monitor list with wallet address, schedule, status, last score/
  confidence, unread notification count
- Exposure timeline (`listReadyForWallet`) and event inbox with
  severity/state filtering
- Noise suppression knobs surfaced in the API: cooldown hours, minimum
  severity, minimum confidence, score delta threshold, per-type toggles

## Health + budgets (D4-I)

- `/health/ready` includes monitor dependencies; monitoring enabled flag
  participates in readiness
- Kill switch: ENABLE_MONITORING=false disables the pipeline and
  scheduler sweep without touching cached reports or the dashboard
- Hourly monitor job budget (MAX_MONITOR_JOBS_PER_HOUR), due-run cap
  (MAX_ACTIVE_MONITOR_JOBS), queue depth cap (MAX_MONITOR_QUEUE_DEPTH),
  worker concurrency (MONITOR_WORKER_CONCURRENCY), retry limit
  (MONITOR_CHECK_RETRY_LIMIT)
- Event expiry (MONITOR_EVENT_EXPIRY_DAYS) runs opportunistically
  after each pipeline

## Regression harness (D4-J)

### Unit tests

- `packages/diff/src/index.test.ts` — 11 tests: dimension diffing,
  signal identity, entity diff, attack path reorder-insensitivity,
  data quality drop, comparability/version drift, diff confidence
- `packages/monitor/src/threat.test.ts` — 16 tests: candidate
  generation per event type, severity bands, floors, toggles, cooldown,
  hysteresis (suppress equal repeat, allow larger repeat)

### Golden monitors

`tests/golden-monitors.ts` (`pnpm test:monitors`) — deterministic
offline harness (no RPC) covering 9 cases: no-change, small change,
major score increase, new entity (HIGH for exchange), new repeated
funder, new attack path, data quality drop, engine version change,
duplicate delivery suppressed by cooldown.

### Load test

`tests/load-test-monitors.ts` (`pnpm loadtest:monitors`) — provisions N
fresh wallets with a baseline + current analysis (synthetic fixtures,
no RPC), registers one active monitor per wallet, runs the full
pipeline (diff → threat → rules → event/notification persistence) at
configurable concurrency, then re-runs the same pipelines to verify
idempotency.

### End-to-end test

`tests/e2e-monitor.ts` (`pnpm test:e2e-monitor`) — resets the database
and runs the full lifecycle from scheduler sweep → per-monitor check →
new analysis → fan-out → pipeline → events/notifications →
idempotency → ownership (see results below).

## Verification results

### Final regression (whole repo)

- `pnpm -r typecheck` — 0 errors across all 18 packages
- `pnpm -r test` — all unit suites pass (diff 11, monitor 16, plus
  existing suites)
- `pnpm -r build` — all packages build
- `pnpm test:monitors` — 9/9 golden cases pass
- `pnpm test:e2e-monitor` — 14/14 end-to-end checks pass on a clean
  database (details below)

### Load test results

Run: `pnpm loadtest:monitors --count=10 --concurrency=5`
(10 fresh wallets, 5 concurrent pipeline runs; repeated runs on a
freshly migrated database for reproducibility)

| Metric | Run 1 | Run 2 |
| --- | --- | --- |
| Provisioning | 190ms | 307ms |
| First pass | 10 runs, 0 failures, 209ms | 10 runs, 0 failures, 377ms |
| Throughput | 47.85 ops/s | 26.53 ops/s |
| Latency p50 / p95 | 139ms / 145ms | 276ms / 299ms |
| Threat events persisted | 2 per monitor (exposure increase + entity) | same |
| Notifications | 2 per monitor (in-app) | same |
| Idempotency re-run | 0 duplicate events, 0 duplicate notifications | same |

Throughput variance between runs is machine-load dependent (the second
run followed a database reset + full regression); the invariants that
matter are stable: 0 failures, 2 events + 2 notifications per monitor,
and idempotency re-runs creating zero duplicates (D4-J §83, §99).

Idempotency verified end-to-end: re-running the same analysis fan-out
for all 10 monitors created no new diffs, events or notifications
(D4-J §83, §99).

### End-to-end monitor flow (clean state)

`tests/e2e-monitor.ts` (`pnpm test:e2e-monitor`) — resets the database
(drop schema → migrate 0001–0003), then runs the full lifecycle:

1. Provision user, wallet, baseline analysis (READY, score 24), saved
   analysis, monitor registered with baseline + alert rules
2. Scheduler sweep picks up the due monitor (audit row inserted)
3. Per-monitor check reuses the fresh READY analysis — check row marked
   REUSED, no new analysis job enqueued
4. New analysis (READY, score 61 + Coinbase exchange signal) triggers
   the analysis-complete fan-out → monitor pipeline
5. Verifies: diff persisted, PRIVACY_EXPOSURE_INCREASED HIGH +
   NEW_ENTITY_EXPOSURE HIGH (exchange), in-app notifications, monitor
   last_analysis_id advanced
6. Idempotency: re-running the same fan-out creates 0 duplicate events
   and 0 duplicate notifications
7. Ownership: another user cannot read the monitor (RLS/ownership)
8. Event lifecycle: acknowledge

Result: **14/14 checks passed** on a clean database.

## Bugs discovered & fixed

1. **Entity type key mismatch**: the intelligence engine emits evidence
   key `entity_type` (snake_case), but the diff engine read `entityType`
   — every NEW_ENTITY event was classified MEDIUM instead of HIGH for
   centralized exchanges. Fixed in `diffEntities` with
   `firstEvidenceValue(s, "entity_type", "entityType")`; golden case
   #4 now asserts HIGH for an exchange.
2. **Hysteresis compared against cooldown window**: the original
   hysteresis check used the cooldown-window event, so a repeated
   increase after cooldown expiry could not be compared at all. Now
   compared against the last event of the same fingerprint regardless
   of window (D4-H §65).
3. **occurrence_count typed string**: `recentForMonitor` returns the
   column as text; `> 1` comparison compiled but was wrong at runtime.
   Wrapped in `Number()`.
4. **Test fixtures drifted from engine output**: golden fixture lacked
   `entity_type` evidence; engine-version drift in the load-test
   fixture suppressed score events (confidence 0.42 < 0.5 floor).
   Fixtures now mirror real engine output and use identical engine
   versions for comparable analyses.

## Known limitations

- Email delivery not exercised against a real SMTP provider in this
  environment; the delivery worker and status guard are unit-reviewable
  and the in-app path is verified end-to-end
- Monitor scheduling verified via queue mechanics; a full wall-clock
  wait for a DAILY window is impractical in tests — the sweep and
  per-monitor run paths are exercised directly
- Hysteresis compares only score-increase event types; entity/attack
  path repeats rely on the fingerprint cooldown
- MAX_MONITOR_JOBS_PER_HOUR counts monitor_checks rows; a sweep failure
  does not decrement the budget

## Operational procedures

- Migrations: `pnpm --filter @aegix/database migrate` (0001–0003)
- Golden monitor regression: `pnpm test:monitors` (needs local Postgres)
- Monitor load test: `pnpm loadtest:monitors --count=N --concurrency=M`
- Kill switch: `ENABLE_MONITORING=false` (restart API/worker)
- Noise tuning: MONITOR_MIN_CONFIDENCE, MONITOR_SCORE_DELTA_THRESHOLD,
  MONITOR_EVENT_COOLDOWN_HOURS, per-monitor alert rules via API
- Budget tuning: MAX_ACTIVE_MONITOR_JOBS, MAX_MONITOR_JOBS_PER_HOUR,
  MAX_MONITOR_QUEUE_DEPTH, MONITOR_WORKER_CONCURRENCY

## Recommended next milestone (D5)

1. Live email provider wiring (Resend/SES) with verified delivery
2. Monitor pause/resume UX in the dashboard + bulk actions
3. Real-time push (websocket) for inbox updates
4. Entity registry enrichment: severity per entity category beyond
   exchanges (mixers, gambling, bridges)
5. Cross-wallet correlation: cluster-level monitoring when multiple
   monitored wallets share counterparties
