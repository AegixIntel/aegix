# Milestone D6 — Wallet-Only Identity, Developer Intelligence, Correlation Alerts & Closure

Authoritative D6 completion report. D6 shipped in three blocks:

- **Block 1** (commit `809fc35`, see `docs/d6-block1.md`): saved comparisons
  (D6-A), developer API foundation (D6-B..D6-D).
- **Block 2** (commit `890d2b9`, see `docs/d6-block2.md`): wallet-only
  authentication (D6-P), developer intelligence API (D6-E), population
  commonality index (D6-G), monitor-driven correlation alerts (D6-F),
  signed webhook delivery (D6-H).
- **Block 3** (this close, commit `…`): correlation alert EMAIL delivery
  (D6-I1), population commonality production enablement (D6-I2), compare UX
  for commonality (D6-I3), webhook consumer verification (D6-I4),
  production/abuse/security hardening (D6-J), final E2E/load validation
  (D6-K), closure (D6-L).

```text
WALLET (Ed25519) ──challenge/sign──→ session (hash-only) → product identity
NOTIFICATION EMAIL (verified, optional) ──destination only, never identity──┘
ANALYSIS ──worker──→ population stats (snapshot semantics, opt-in)
MONITOR CHECK ──correlation baseline diff──→ threat events
   ├── IN_APP notification (fingerprint-deduped)
   ├── EMAIL (verified destination, same idempotency)
   └── WEBHOOK (HMAC-signed, SSRF-protected, dedicated queue)
COMPARE ──commonality source (POPULATION | STATIC | FALLBACK)──→ UI
```

---

## 1. Architecture (final)

### 1.1 Identity model

Wallet-only authentication is canonical. A wallet (Ed25519 public key) is
the credential; the profile is the stable internal UUID. Sessions hold a
random 32-byte token, hash-only at rest, with real revocation. The legacy
Supabase JWT bridge is gated behind `ENABLE_LEGACY_AUTH=false` in
production — no product login UI depends on Supabase.

The **notification email is a separate concept**: an optional, verified
destination for alerts. It is never a login identity (no email
login/signup/magic-link/password exists anywhere).

### 1.2 Data flow

- **Analyses** (D1-D5) persist normalized activity + intelligence.
- **Population commonality**: each completed analysis contributes one
  wallet's observed keys (counterparty/program/mint) to
  `population_observation_stats` with snapshot semantics — re-analysis
  replaces the contribution, never double-counts.
- **Monitor checks** diff persisted analyses, evaluate threat + correlation
  changes, dedupe by fingerprint, then fan out to IN_APP / EMAIL / WEBHOOK.
- **Developer API** rides the product identity: API keys (hash-only at
  rest) → scopes → per-user atomic daily quota → metered usage events →
  bounded async work.

## 2. Migration 0008 (`packages/database/migrations/0008_d6_block3.sql`)

1. **`notifications.event_id` FK dropped** (real bug, see §10): the column
   stays a loose bigint reference so it can point at `threat_events` OR
   `correlation_threat_events` (same polymorphic pattern as `monitor_id`).
2. **`profiles` notification-email columns**: `notification_email`,
   `notification_email_verified_at`, verification-code digest/expiry/attempt
   counters. Email is a verified destination only.

## 3. D6-I1 — Correlation Alert Email Delivery

- Correlation events that survive threshold/confidence/hysteresis/cooldown/
  idempotency fan out to **EMAIL in addition to IN_APP + WEBHOOK** using the
  existing notification pipeline (no second email subsystem).
- **Eligibility** (`correlationEmailEligibility`): `EMAIL_ENABLED` +
  `ENABLE_EMAIL_NOTIFICATIONS` + configured provider + **verified
  notification email on the profile**. No verified destination → no EMAIL
  row; unverified addresses are never emailed.
- **Recipient resolution at delivery time** (`deliverNotification`): the
  worker re-reads the profile's verified email — a stale/removed destination
  suppresses delivery instead of sending to a wrong address. (This also
  fixes a latent bug where the legacy path emailed the user UUID.)
- **Idempotency**: one logical correlation event produces at most one EMAIL
  notification (fingerprint-derived idempotency key), and BullMQ retries are
  guarded by the notification PENDING status — no duplicate sends.
- **Retry taxonomy**: transient (timeout/connection/4xx-SMTP) retries with
  backoff; permanent (invalid recipient/rejected auth) fails immediately.
- **Content** (`buildCorrelationEmail`): concise, epistemically safe —
  event type, monitored + related wallet, previous/new strength, confidence,
  evidence changes (added/removed families), timestamp, Compare link, and
  the standing "correlation does not prove ownership/identity" disclaimer.
- **API** (`/v1/me/email`): GET state, PUT set (delivers a 6-digit code via
  the same email provider), POST verify (bounded attempts, code digest only
  at rest), DELETE remove. `EMAIL_ENABLED`/`ENABLE_EMAIL_NOTIFICATIONS`
  remain the global kill switches.

## 4. D6-I2 — Population Commonality Production Enablement

The subsystem flag (`ENABLE_POPULATION_COMMONALITY`) is **not** the same as
the penalty being active. `commonalityStatus` resolves:

```text
enabled + aggregation exists + population >= COMMONALITY_MIN_POPULATION
       + snapshot age <= COMMONALITY_MAX_SNAPSHOT_AGE_HOURS
       ──► source: POPULATION (eligible)
otherwise ──► source: FALLBACK / STATIC → D5 static common-activity treatment
```

- **Engine gate**: `computeCorrelation` now receives `populationSize`; the
  overlap engine only discounts shared keys when the observed population
  reached the configured minimum (regression-tested: frequencies from a
  50-wallet population with `minPopulation=100` change nothing).
- **Staleness**: `COMMONALITY_MAX_SNAPSHOT_AGE_HOURS` (default 336h = 14d);
  older snapshots fall back instead of being treated as current truth.
- **Health**: `GET /v1/health/commonality` exposes enabled/eligible/source/
  populationSize/minimumPopulation/snapshotAgeHours/version/
  lastAggregationAt — no raw wallet data.
- **Compare wiring** (real gap fixed): `runComparison` previously never
  passed population frequencies into the correlation engine. It now loads
  frequencies for the shared key space, passes `commonalityByAddress` +
  `populationSize`, and reports the source + per-key notes.
- **Double-count validation**: e2e proves same-wallet re-aggregation is a
  no-op (`population size stable`); the correlation engine tests prove
  re-analysis of one wallet ≠ +N wallets.
- **FP validation (static vs population)**: shared common hub stays weak or
  weaker with population data; rare counterparties stay meaningful; known
  negatives are never strengthened (test suite `population-commonality.test.ts`,
  plus the D5 FP matrix stays green).

## 5. D6-I3 — Commonality Compare UX

- `CompareResult.commonality` carries `source`, `eligible`, population
  metadata, and bounded per-key notes (≤12) for actually-shared
  counterparties + entities.
- The compare page renders a **"Why this shared activity matters"** section
  (mobile-friendly cards, no horizontal tables): key name/address,
  treatment (MEANINGFUL / DISCOUNTED / HEAVILY DISCOUNTED / STATIC), observed
  frequency ("Observed in X% of eligible AEGIX-analyzed wallets"), and a
  plain-language reason.
- Population unavailable → explicit amber notice ("Population commonality
  unavailable — static common-activity treatment applies"); stale data never
  renders as current.
- **Disclaimer is visible in the UI** wherever empirical frequencies appear:
  "Population statistics are based on wallets analyzed by AEGIX and do not
  represent the entire Solana network."
- Strength ≠ confidence is preserved (commonality only affects evidence
  contribution). Copy helpers are unit-tested (`apps/web` now runs real
  tests).

## 6. D6-I4 — Webhook Consumer Verification

- `verifyWebhookRequest` (in `@aegix/webhook-delivery`, exported from the
  package index): constant-time HMAC verification over
  `timestamp + "." + rawBody`, timestamp format + tolerance checks
  (default 300 s), explicit failure reasons (missing/malformed/too-old/
  too-far-in-future/mismatch).
- **Raw-body requirement is documented and tested**: JSON.parse →
  JSON.stringify with any byte difference fails; unicode/empty bodies are
  byte-exact.
- `docs/webhooks.md`: envelope, headers, exact signing scheme, retry &
  idempotency semantics, secret-rotation behavior, security notes, and a
  hand-rolled example in addition to the helper.
- No full SDK was built (explicit out of scope).

## 7. D6-J — Production / Abuse / Security Hardening

- **Webhook delivery**:
  - Audit trail now records the **real attempt number** (BullMQ
    `attemptsMade+1`) — previously every retry was recorded as attempt 1.
  - **3xx responses are permanent failures** (redirects are never followed;
    previously 3xx retried forever).
  - **Bounded failure storm**: transient failures increment
    `failure_count`; the webhook degrades at 3 and is disabled at
    `WEBHOOK_DISABLE_AFTER_FAILURES` (default 10) — one broken endpoint
    cannot retry forever.
  - Response bodies are read with a hard cap (no unbounded buffering);
    strict timeout retained; payload size limit retained.
  - SSRF test coverage expanded: localhost, 0.0.0.0, ::, IPv4-mapped IPv6,
    metadata IP, and DNS-resolving-to-private (localhost) all blocked.
- **Production config validation** (fail fast): webhook encryption key,
  SMTP host when email+smtp is enabled, `WEBHOOK_DEV_ALLOW_PRIVATE` must be
  false, auth domain/URI must not be localhost.
- **API body limit**: raised from the accidental 1024-byte ceiling to
  `API_BODY_LIMIT_BYTES` (64 KB default) — labels/notes up to their schema
  maxima now actually work; oversized bodies still 413.
- **Error responses**: custom Fastify error handler — 4xx surfaces safe
  schema messages; 5xx returns a generic envelope (stack traces only in
  server logs, never in production responses).
- **Log/secret audit**: no plaintext secrets logged (prefix-only key refs,
  host-only webhook refs, truncated error excerpts, hashed wallet refs);
  verified by search of all logging paths.
- **XSS**: no `dangerouslySetInnerHTML` anywhere; React text rendering.
- Cross-user isolation, quota concurrency, wallet-auth replay/domain/
  expiry, and legacy-auth-off are exercised in the final E2E.

## 8. D6-K — Final E2E + Load

- **`pnpm test:e2e-d6`** (new, clean state: reset → migrate 0001..0008 →
  seed): **51 checks across 10 flows** —
  1. wallet auth (legacy auth off; replay/wrong-domain/logout),
  2. saved comparisons + cross-user,
  3. developer API (keys, quota boundary, revoke),
  4. commonality (small → fallback; ≥20 → eligible; re-analysis no
     double-count),
  5. correlation alert pipeline IN_APP + EMAIL (verified destination) +
     webhook; duplicate cycle → no duplicate logical delivery,
  6. noise suppression (small delta, degraded → INFO only),
  7. webhook signature verification (valid + tamper cases),
  8. webhook failure handling (500 → RETRY + real attempt audit, 410 →
     disabled, repeated failures → disabled, hanging endpoint → strict
     timeout),
  9. SSRF production policy (8 private/reserved targets blocked),
  10. cross-user isolation across notifications/events/monitors.
- **Load (local Postgres+Redis, offline fixtures)**:
  - compare: 20 runs @ concurrency 10 → 0 failures, 126 ms total,
    58 ms avg / 105 ms p95; same-pair 10 @ 10 → 0 failures. (Harness calls
    the comparison service directly; Redis dedup/lock is exercised via the
    API path covered by Block 1 e2e.)
  - quota boundary + population aggregation correctness are covered in
    `test:e2e-d6` (concurrent claims never negative; population stable).
- Honest note: the load harness measures in-process compute, not the Redis
  dedup lock; per-request admission/dedup/quota assertions live in the e2e
  suites.

## 9. Full Regression (final)

| Suite | Result |
|---|---|
| `pnpm -r typecheck` | clean (21/21 incl. web) |
| `pnpm -r build` (packages + api + worker) | clean |
| packages unit tests | all pass (config 6, commonality 6, correlation 43 incl. 8 population, monitor 40, webhook-delivery 23, database, …) |
| `apps/api` unit tests | 31/31 (incl. notification-email 4, body-limit 2) |
| `apps/web` UI-logic tests | 4/4 (new) |
| `test:e2e-d6` (new) | **51/51** |
| `test:e2e-d6-block1` | 42/42 |
| `test:e2e-d6-block2` | 36/36 |
| `test:e2e-d5` | 18/18 |
| `test:e2e-monitor` | 14/14 |
| `test:correlation` | 31/31 |
| `test:correlation-dataset` | 27/27 |
| `test:correlation-block2` | 22/22 |
| `test:monitors` | 9/9 |
| `test:account-classification` | 14/14 |

Note: `next build` fails on a pre-existing `<Html>`/`pages/_document` error
unrelated to D6 (verified against the untouched tree); `apps/web`
`tsc --noEmit` is clean.

## 10. Real Bugs Found & Fixed (Block 3)

1. **`notifications.event_id` FK violation for correlation events** (root
   cause fix): the correlation pipeline writes events into
   `correlation_threat_events` but the notifications FK pointed at
   `threat_events` — every correlation IN_APP/EMAIL notification insert
   failed in the real pipeline (Block 2 e2e exercised repos directly and
   missed it). Fixed by migration 0008 + regression coverage through the
   full pipeline in `test:e2e-d6` Flow 5.
2. **Email recipient = user UUID** (legacy path): EMAIL notifications were
   addressed to the profile UUID. Delivery now resolves the verified
   notification email at send time; missing/unverified → suppressed.
3. **Population-size gate missing in the overlap engine**: `commonalityByAddress`
   was applied regardless of the observed population size — small-population
   frequencies could skew evidence. The engine now enforces
   `populationSize >= commonalityMinPopulation` (fallback = static).
4. **Compare never used population data**: `runComparison` didn't pass
   `commonalityByAddress` into `computeCorrelation` and hard-coded entity
   commonality for the graph. Fully wired with explicit source metadata.
5. **Webhook retry audit collapsed attempts**: every BullMQ retry recorded
   `attempt=1`; now the real attempt number is recorded.
6. **3xx redirects retried forever** (redirects disabled but treated as
   transient); now a permanent failure that disables the webhook.
7. **Unbounded failure retries**: a persistently 500-ing endpoint retried
   until BullMQ exhaustion with no disable; now disabled at
   `WEBHOOK_DISABLE_AFTER_FAILURES`.
8. **Unbounded response buffering** from customer endpoints; now capped.
9. **API body limit was 1024 bytes** — schema-allowed labels/notes (up to
   2000 chars) could never be submitted; raised to a configurable 64 KB with
   a 413 regression test.
10. **Unbounded verification attempts** on the notification-email code are
    bounded (5 attempts, TTL 15 min, digest-only at rest).

## 11. Known Limitations

- **Population commonality represents the population observed through
  eligible AEGIX analyses. It is not a measurement of the entire Solana
  network.** It is off by default until a meaningful population exists;
  the minimum-population and staleness gates guard small/stale samples.
- **AEGIX reports observable relationships and correlation evidence.
  Correlation does not establish common ownership or real-world identity.**
  Alerts, emails, webhooks, and the compare UI carry this disclaimer.
- **Wallet authentication and notification email are separate concepts.**
  AEGIX does not require email for authentication; email alerts require a
  verified destination and are off until one exists.
- Legacy Supabase JWT auth remains behind `ENABLE_LEGACY_AUTH` as a
  temporary bridge; production target runs with it off (verified in e2e).
- Webhook delivery disables after repeated failures; re-enabling is a
  manual dashboard action. Secret rotation replaces the secret immediately
  (no dual-secret grace).
- `next build` (Next.js static prerender) is broken by a pre-existing
  `next/document` import error unrelated to this milestone; `tsc --noEmit`
  on the web app is clean. Not caused by, and not fixed in, D6.

## 12. Production Configuration (Block 3 additions)

```env
# D6-I1 email alerts
EMAIL_ENABLED=false                # master switch (false until SMTP configured)
EMAIL_PROVIDER=console|smtp
EMAIL_SMTP_HOST=...                # required when EMAIL_ENABLED=true + smtp
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=...
EMAIL_SMTP_PASS=...
ENABLE_EMAIL_NOTIFICATIONS=false   # product-level kill switch

# D6-I2 commonality
ENABLE_POPULATION_COMMONALITY=false   # enable after analyzed population grows
COMMONALITY_MIN_POPULATION=20
COMMONALITY_MAX_SNAPSHOT_AGE_HOURS=336

# D6-J hardening
API_BODY_LIMIT_BYTES=65536
WEBHOOK_DISABLE_AFTER_FAILURES=10
AUTH_DOMAIN=https://aegix.app      # required, no localhost in production
AUTH_APP_URI=https://aegix.app
ENABLE_LEGACY_AUTH=false
```

Production startup fails fast when: webhooks enabled without
`WEBHOOK_ENCRYPTION_KEY`, email+smtp without host, `WEBHOOK_DEV_ALLOW_PRIVATE`,
or localhost auth origins are set.

## 13. Engine Versions

- compare: `compare-v1.1.0` (was v1.0.0 — adds commonality wiring)
- correlation: `correlation-v1.0.0` (unchanged core; population penalties
  were already versioned inputs)
- population commonality: `population-commonality-v1.0.0`
- correlation monitor: `correlation-monitor-v1.0.0`
- webhook signing: HMAC-SHA256 over `timestamp + "." + rawBody` (unchanged)

## 14. Files (Block 3)

- `packages/database/migrations/0008_d6_block3.sql`
- `packages/database/src/repositories/profiles.ts` (+ export)
- `packages/database/src/repositories/webhooks.ts` (markOutcome disable cap)
- `packages/database/src/repositories/population-commonality.ts`
  (lastAggregationAt)
- `packages/monitor/src/notification-email.ts` (+ test)
- `packages/monitor/src/pipeline.ts` (email fan-out + verified recipient)
- `packages/monitor/src/index.ts` (exports)
- `packages/correlation/src/index.ts`, `dimensions/overlap.ts`
  (populationSize gate), `population-commonality.test.ts`
- `packages/commonality/src/index.ts` (commonalityStatus), `status.test.ts`
- `packages/webhook-delivery/src/consumer-verify.ts` (+ test), `index.ts`
  (attempt tracking, 3xx disable, bounded body, exports)
- `apps/worker/src/processors/webhooks.ts` (attempt passthrough)
- `apps/api/src/notification-email.ts` (+ test) (routes)
- `apps/api/src/compare.ts` (commonality wiring + notes)
- `apps/api/src/server.ts` (routes, error handler, body limit,
  /v1/health/commonality)
- `apps/api/src/server.test.ts`, `package.json`
- `apps/web/src/lib/api.ts`, `components/compare-page.tsx`,
  `components/commonality.test.ts`
- `packages/config/src/index.ts` (+ config.test.ts), package test scripts
- `tests/e2e-d6.ts`, `package.json` (`test:e2e-d6`)
- `docs/webhooks.md`, `docs/milestone-d6.md`

## 15. Direction (after D6)

D7 candidates (NOT started): AI explanation layer, billing, multi-chain,
full indexer, webhook consumer SDK, landing page redesign.
