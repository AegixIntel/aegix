# Milestone D6 Block 2 — Wallet-Only Auth, Commonality, Correlation Alerts & Webhooks

Authoritative D6 Block 2 completion report: wallet-only authentication
(D6-P), developer intelligence API (D6-E), population commonality index
(D6-G), monitor-driven correlation alerts (D6-F) and signed webhook
delivery (D6-H).

```text
WALLET (Ed25519) ──challenge/sign──→ session (hash-only) ─→ product identity
ANALYSIS ──worker──→ population stats (snapshot semantics, opt-in)
MONITOR CHECK ──correlation baseline diff──→ threat events ─→ notifications + webhooks
WEBHOOK ──HMAC-signed, SSRF-protected, dedicated queue──→ customer endpoint
```

**Commits:** single milestone close on top of D6 Block 1 (`809fc35`).

---

## 1. D6-P — Wallet-only authentication

The product has **no email/password/magic-link/OAuth login anywhere**. The
wallet is the credential; the profile is the stable internal identity.

### 1.1 Challenge-response flow

- `POST /v1/auth/wallet/challenge` — server issues a nonce (32 random bytes
  from `node:crypto`, base64url) bound to the trusted domain.
- `POST /v1/auth/wallet/verify` — Ed25519 signature over the exact
  human-readable message; atomic single-use consume; session issued.
- `POST /v1/auth/logout` — real revocation.
- `GET /v1/auth/me` — session identity resolution.

### 1.2 Security invariants

- **Nonce hash-only at rest**: the DB stores the SHA-256 digest, never the
  nonce — a DB compromise exposes no usable challenges.
- **Domain/URI are server configuration** (`AUTH_DOMAIN`, `AUTH_APP_URI`),
  never client-supplied.
- **The signed message is deterministic**: wallet, nonce, domain, uri,
  issued-at, expiry and version. Any modified byte fails verification.
  Format changes require bumping `WALLET_AUTH_MESSAGE_VERSION`.
- **Atomic single-use consumption** (`update ... where consumed_at is null
  returning`) — replay AND oracle probing are impossible: the challenge is
  consumed even when the signature is invalid.
- **Session token**: random 32-byte secret; only its hash is stored;
  revocation is real (`revoked_at`); `last_used_at` touch is throttled to
  ≤1 write/minute.
- **First login is idempotent under concurrency**: partial unique index on
  `profiles.primary_wallet` + on-conflict bind; concurrent first logins
  resolve to one profile.
- **Challenge cap** (`WALLET_AUTH_MAX_PENDING_PER_WALLET`, default 5):
  pending (unconsumed, unexpired) challenges are counted before insert —
  an attacker cannot accumulate challenges for a wallet.

### 1.3 Schema (migration 0007)

`profiles.primary_wallet` (unique when set), `user_wallet_identities`
(binding, `is_primary`), `wallet_auth_challenges` (nonce hash, single-use),
`sessions` (token hash, revocable). RLS scoped to `auth.uid()` like 0003/0006.

## 2. D6-E — Developer intelligence API

Thin orchestration over the D1-D5 intelligence on the D6 Block 1 developer
rails (auth/scopes/quota/metering):

- `POST /v1/developer/intelligence/wallet` — reuse-first: cache → fresh
  persisted analysis → deduped job → 202 + poll URL (never request-blocking
  RPC crawling). Cost: `DEVELOPER_INTELLIGENCE_QUOTA_UNITS_WALLET` (1).
- `POST /v1/developer/intelligence/compare` — canonical cache + dedup lock +
  reuse-first; cost 2 units.
- `GET /v1/developer/intelligence/analysis/:id` — job status polling.
- `GET /v1/developer/intelligence/comparison/:pairId` — persisted result.

All responses strip ownership/identity language (`stripSensitive`) — the
same epistemic-safe rules as the product UI. Kill switch:
`ENABLE_DEVELOPER_INTELLIGENCE_API=false`.

## 3. D6-G — Population commonality index

Empirical frequency over the **AEGIX-analyzed population** (not the full
chain). Worker-triggered, opt-in (`ENABLE_POPULATION_COMMONALITY=false`
default — off until enough analyzed population exists).

- **Aggregation** (`packages/commonality`): one wallet's normalized
  observations (counterparties, programs, mints) are aggregated with
  snapshot semantics — a re-analysis **replaces** the wallet's previous
  contribution; retries/duplicate execution are no-ops via
  `population_contribution_state` (idempotency anchor storing the
  contributed keys).
- **Stats**: `population_observation_stats` — distinct wallets per key (a
  single hyperactive wallet cannot make something "common"), total
  observations, population size, frequency = distinct_wallets / population.
- **Penalty**: smooth bounded function `[0, 0.9]` with a rarity floor
  (5%) — no binary cliff; small populations
  (`COMMONALITY_MIN_POPULATION`, default 20) are never penalized.
- **Bounded work**: only the wallet's own rows are scanned
  (`transfersForWallet`/`programInteractionsForWallet`, capped 5000);
  aggregation failure is logged, never fails the analysis.

## 4. D6-F — Monitor-driven correlation alerts

Detects **meaningful, explainable** changes in a monitored wallet's
persisted correlations (opt-in `ENABLE_CORRELATION_MONITOR_ALERTS=true`).

- **Bounded candidates**: only wallets already present in persisted
  intelligence (`correlation_results` for the monitored wallet), capped by
  `MAX_MONITOR_CORRELATION_CANDIDATES` — never a global pairwise scan.
- **Baselines**: `monitor_correlation_baselines` per (monitor, canonical
  pair); a cycle compares previous vs current persisted state.
- **Noise control**: hysteresis (enter strong ≥ 60, exit ≤ 45), min delta,
  min score/confidence per monitor rules, cooldown by event fingerprint,
  oscillation guard (repeated INCREASED must exceed the last score),
  fingerprint-deduped events (occurrence_count, no duplicate rows).
- **Degraded data never fabricates DISAPPEARED**: absence from persisted
  results yields a low-confidence (0.4) INFO event, not a conclusion.
- **Language**: events describe observable correlation, never ownership.

## 5. D6-H — Signed webhook delivery

- **Management** (`/v1/webhooks`, product session): create (secret shown
  once), list, detail, patch, rotate secret, delete, test delivery.
- **Secrets**: AES-256-GCM encrypted at rest (`WEBHOOK_ENCRYPTION_KEY`,
  32+ chars; fail-fast in production when webhooks are enabled); the
  plaintext is shown exactly once.
- **Signing**: HMAC-SHA256 over `timestamp + "." + rawBody`; headers
  `aegix-webhook-id`, `aegix-event-id`, `aegix-timestamp`,
  `aegix-signature` — consumers verify freshness and integrity.
- **Async delivery** on the dedicated `webhooks` BullMQ queue — a broken
  customer endpoint can never starve analysis/monitor workers.
- **SSRF protection at delivery time** (release blocker): resolve → validate
  IP (RFC1918/loopback/link-local/metadata/reserved rejected) → connect to
  the validated IP with the original Host header; redirects disabled;
  intentional port policy (`WEBHOOK_ALLOWED_PORTS`, default 80,443);
  `WEBHOOK_DEV_ALLOW_PRIVATE` for local development only.
- **Retry/disable policy**: transient (5xx/408/429) → BullMQ exponential
  backoff (max `WEBHOOK_MAX_ATTEMPTS`); permanent (4xx) or SSRF → disable
  the webhook with a reason; `webhook_deliveries` keeps the audit trail
  (bounded error excerpt).
- **Event fan-out**: monitor threat + correlation events map to
  `monitor.threat.created` / `correlation.appeared|increased|decreased|
  disappeared`; enqueue is best-effort and never blocks the pipeline.

## 6. Verification (final)

| Suite | Result |
|---|---|
| `pnpm -r typecheck` | clean (20/20) |
| `pnpm -r build` | 20/20 packages |
| `pnpm -r test` (unit) | all pass — explanation 3, graph 25, database 7, blockchain 13, intelligence 5, logging 4, scoring 8, normalizer 11, diff 11, correlation 36, monitor 31 (incl. 12 new correlation), webhook-delivery 11 (new), api 25 (incl. 5 new wallet-auth) |
| `test:e2e-d6-block2` (new, clean state) | 36/36 |
| `test:e2e-d6-block1` | 42/42 |
| `test:e2e-d5` | 18/18 |
| `test:e2e-monitor` | 14/14 |
| `test:correlation` (golden) | 31/31 |
| `test:correlation-dataset` (FP matrix) | 27/27 |
| `test:correlation-block2` | 22/22 |
| `test:monitors` (golden) | 9/9 |
| `test:account-classification` | 14/14 |

All e2e suites run from a clean state (reset schema → migrate 0001..0007 →
seed → flows). `test:wallets` (live RPC) is environment-dependent and was
not part of the offline gate.

## 7. Bugs Found & Fixed (during verification)

1. **`replaceContribution` referenced a non-existent column**
   (`population_contribution_state.observation_type`): the stale-contribution
   delete always failed with `42703`. Fixed: the state row now stores the
   contributed keys (`observation_keys jsonb`); a re-analysis decrements
   exactly the keys the wallet previously contributed (`greatest(0, n-1)`),
   never touching other wallets' contributions.
2. **`aggregatePopulation` compared addresses against wallet ids**: transfer
   rows store addresses but the self-exclusion compared `from/to_address`
   against `input.walletId` (numeric), so every counterparty was dropped and
   no stats were produced. Fixed: resolve the wallet's address first and
   compare against it.
3. **Challenge cap was never enforced**: `insertChallenge` accepted
   `maxPendingPerWallet` but never counted pending challenges — an attacker
   could accumulate unlimited challenges. Fixed: count unconsumed, unexpired
   challenges before insert; at/above the cap the caller receives
   `CHALLENGE_LIMIT_REACHED`.
4. **issued-at race made verification flaky**: the signed message embeds
   `issuedAt`, but the repo defaulted to its own `now()` — when the two
   milliseconds differed, verification rebuilt a different message than the
   wallet signed (`INVALID_SIGNATURE`). Fixed: `issueChallenge` passes the
   exact `issuedAt` it embedded into the message to the insert.
5. **`WEBHOOK_ENCRYPTION_KEY` had an unsafe empty default with webhook
   delivery ON by default**: production would silently run without secret
   encryption. Fixed: production `loadConfig` fails fast when webhooks are
   enabled and the key is missing (same pattern as DB/Redis/RPC).
6. **New unit tests caught contract mistakes** (not code bugs): the
   correlation hysteresis guard applies to `CORRELATION_INCREASED` only
   (APPEARED is a new edge), and the low-confidence suppression test needed
   a raised `minConfidence` rather than a sub-threshold candidate.

## 8. Known Limitations

- Population commonality is OFF by default until the analyzed population
  reaches a meaningful size; the penalty floor (5%) and
  `COMMONALITY_MIN_POPULATION` guard small-sample overstatement.
- Correlation alerts compare persisted correlation results; pairs that are
  no longer persisted degrade to INFO-level DISAPPEARED (never a strong
  conclusion) until re-analysis provides fresh data.
- Webhook delivery retries use BullMQ's exponential backoff; `next_retry_at`
  is a computed estimate, not a scheduler-bound promise.
- `WEBHOOK_DEV_ALLOW_PRIVATE` exists for local development only; production
  must keep it false (SSRF policy).
- Legacy Supabase JWT auth remains behind `ENABLE_LEGACY_AUTH` as a
  temporary bridge; wallet sessions take precedence when both are present.

## 9. Production Configuration (Block 2)

```env
# D6-P
AUTH_DOMAIN=https://aegix.app
AUTH_APP_URI=https://aegix.app
WALLET_AUTH_CHALLENGE_TTL_SECONDS=300
WALLET_AUTH_MAX_PENDING_PER_WALLET=5
WALLET_AUTH_RATE_LIMIT_CHALLENGE=10
WALLET_AUTH_RATE_LIMIT_VERIFY=20
SESSION_TTL_SECONDS=604800
ENABLE_LEGACY_AUTH=false

# D6-E
ENABLE_DEVELOPER_INTELLIGENCE_API=true
DEVELOPER_INTELLIGENCE_QUOTA_UNITS_WALLET=1
DEVELOPER_INTELLIGENCE_QUOTA_UNITS_COMPARE=2

# D6-G
ENABLE_POPULATION_COMMONALITY=false   # enable after population threshold
COMMONALITY_MIN_POPULATION=20

# D6-F
ENABLE_CORRELATION_MONITOR_ALERTS=true
MAX_MONITOR_CORRELATION_CANDIDATES=20
CORRELATION_ALERT_ENTER_STRONG=60
CORRELATION_ALERT_EXIT_STRONG=45
CORRELATION_ALERT_MIN_DELTA=10

# D6-H (required in production when webhooks are enabled)
ENABLE_WEBHOOK_DELIVERY=true
WEBHOOK_ENCRYPTION_KEY=<32+ chars, secret>
WEBHOOK_TIMEOUT_MS=5000
WEBHOOK_MAX_ATTEMPTS=8
WEBHOOK_WORKER_CONCURRENCY=2
WEBHOOK_PAYLOAD_MAX_BYTES=65536
WEBHOOK_ALLOWED_PORTS=80,443
WEBHOOK_DEV_ALLOW_PRIVATE=false
```

## 10. Cost Observations

- Wallet auth: 1 insert + 1 count per challenge; verify = 1 atomic update +
  1 profile lookup + 1 session insert. Challenge rows expire naturally and
  are purged opportunistically.
- Population aggregation: bounded to the wallet's own rows (≤5000 transfers
  + interactions); snapshot replace is one transaction with a single
  `jsonb_to_recordset` batch upsert — no full-table scans.
- Correlation alerts: per monitor cycle, one bounded candidate query + N
  baseline lookups; events are fingerprint-deduped (one row per event).
- Webhook delivery: one resolve+validate per attempt, one signed POST,
  one delivery row; transient failures retry with backoff, permanent
  failures disable immediately (no retry cost).

## 11. D6 Direction (next)

- D6-F remaining: correlation alert delivery to email channels.
- Population commonality enablement: tune `COMMONALITY_MIN_POPULATION` and
  the rarity floor once the analyzed population grows; expose commonality
  in the compare UI with epistemic-safe labels.
- Webhook consumer SDK / verification docs.
