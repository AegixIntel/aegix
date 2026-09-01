# Milestone D6 Block 1 — Saved Comparisons & Developer API

Authoritative D6 Block 1 completion report: product bookmarks for
comparisons (D6-A) plus a bounded, quota'd, scope-based developer API
surface (D6-B..D6-D).

```text
COMPARE RESULT (D5, cacheable, shared) ─┐
                                        ├─→ saved_comparisons (user bookmark, thin)
API KEY (hash-only at rest) ─→ auth chain ─→ quota counter (atomic) ─→ usage events (audit)
```

**Commits:** this milestone close (single commit on top of D5 `96571be`).

---

## 1. D6-A — Saved Comparisons (user bookmarks)

### 1.1 Goal

Registered users bookmark comparison results for later review. The
intelligence payload (evidence, paths, clusters) is **not** copied per user:
the row stores the canonical pair + an optional reference to the persisted
`correlation_results` row, so the shared, cacheable result is reused.

### 1.2 Schema (`saved_comparisons`, migration 0006)

- `user_id` → `profiles(id)` (cascade), `pair_key` = canonical sorted pair.
- **Idempotency**: `unique (user_id, pair_key)` — one bookmark per canonical
  pair; saving (B,A) resolves to the (A,B) row (upsert preserves display
  orientation `wallet_a`/`wallet_b` and existing label/notes).
- `comparison_result_id` → `correlation_results(id)` `on delete set null`:
  deleting the shared result never deletes the bookmark, it just loses the
  snapshot reference.
- Indexes: `(user_id, created_at desc)` for the dashboard list; `pair_key`
  for reuse lookups.
- RLS: select/insert/update/delete policies scoped to `auth.uid()`.

### 1.3 API (`/v1/me/saved-comparisons`, product-session auth)

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/me/saved-comparisons` | validate addresses (format + self-pair), resolve canonical pair, reference existing persisted result if present — **never triggers analysis** (§12), upsert |
| GET | `/v1/me/saved-comparisons` | list with joined snapshot (score/confidence/classification/engine_version/result_created_at), `limit/offset/sort/order` (sort: `created_at` default, `updated_at`, `last_opened_at`) |
| GET | `/v1/me/saved-comparisons/:id` | detail + **historical result reuse**: Redis cache first, else rebuild from persisted analyses (never re-analyze), `stale` flag when no fresh data |
| PATCH | `/v1/me/saved-comparisons/:id` | update `label`/`notes` only |
| DELETE | `/v1/me/saved-comparisons/:id` | delete the bookmark, never the shared result |

Kill switch: `ENABLE_SAVED_COMPARISONS=false` → 403 `FEATURE_DISABLED`.
Cross-user access is denied at both the repo layer (user-scoped queries) and
RLS (policies).

### 1.4 Frontend

- Save button on the compare page (`POST /v1/me/saved-comparisons`).
- Dashboard "Saved Comparisons" section (list + snapshot join).
- Detail page `dashboard/saved-comparison/[id]` reuses the persisted result
  and shows `stale` when the underlying analysis is no longer fresh.

## 2. D6-B — Developer API surface & response envelope

- Versioned namespace `/v1/developer/*` (intelligence endpoints are NOT
  exposed in Block 1; D6-E exposes them).
- Bearer-token auth only — **never query strings** (§56).
- Response envelope:
  - success: `{ data, meta: { requestId, timestamp } }`
  - error: `{ error: { code, message }, meta: { requestId } }`
- Error taxonomy: `INVALID_API_KEY`, `REVOKED_API_KEY`,
  `INSUFFICIENT_SCOPE`, `RATE_LIMITED`, `QUOTA_EXCEEDED`,
  `INVALID_REQUEST`, `FEATURE_DISABLED`, `INTERNAL_ERROR`.

## 3. D6-C — API keys

### 3.1 Key format & entropy

`aegix_live_<base58(16 random bytes)>` — 128 bits from `node:crypto`
`randomBytes`, never `Math.random`/timestamps (§40, §99). The lookup prefix
is the first 17 chars (`aegix_live_` + 6 random base58 chars) —
`API_KEY_PREFIX_LENGTH`, never a hard-coded literal (§104).

### 3.2 Hashing & storage

- SHA-256 hex digest of the **full** key; high-entropy key ⇒ no KDF, no
  pepper (§41). The DB stores only the hash; there is no retrieval path.
- Constant-time verification via `timingSafeEqual` (§42).
- Partial unique index on `key_prefix where status = 'ACTIVE'`: one live key
  per prefix; revoked keys retain their row for audit attribution (§46).

### 3.3 Auth chain (per request, in order)

1. Header extraction (Bearer only, §56).
2. Format validation (prefix + min/max length).
3. Indexed prefix lookup — `findByPrefix` (any status), **no scan** (§55).
4. Constant-time full-key hash verification (§42).
5. Status check: `ACTIVE` only; revoked/expired → `REVOKED_API_KEY` (§46, §49).
   Order matters: status is checked AFTER hash verification so callers can
   never distinguish "prefix exists" from "prefix missing" without a valid key.
6. Throttled `last_used_at` touch (≤1 write/key/minute, §50).

### 3.4 Key lifecycle

- **Create** (`POST /v1/developer/keys`, product session): name, scopes
  (validated against `KNOWN_API_KEY_SCOPES`), optional TTL
  (`expiresInDays`, 1..365); plaintext returned **exactly once**; active-key
  cap `MAX_ACTIVE_API_KEYS_PER_USER` (default 10) → 429 `KEY_LIMIT_REACHED`.
- **List** (`GET /v1/developer/keys`): view contains prefix, never hash or
  plaintext.
- **Revoke** (`POST /v1/developer/keys/:id/revoke`): irreversible; row
  retained for usage attribution; 404 when not found/not active.
- **Rotate** (`POST /v1/developer/keys/:id/rotate`): generates the new key
  and revokes the old in **one transaction** — persistence failure never
  leaves the user with no key (§48). Expired keys cannot be rotated.
- **Expiration**: `expires_at`; expired keys fail auth deterministically and
  are excluded from the active count.

Scopes (Block 1): `intelligence:read`, `usage:read`. Unknown scopes are
rejected at creation.

## 4. D6-D — Usage metering & quota

### 4.1 Tables

- `developer_usage_events` — event-level audit trail. `request_id` is the
  idempotency anchor (unique; retries never double-meter, §75).
  `user_id` is nullable: **unauthenticated rejections are recorded with a
  NULL attribution** so the audit trail keeps them without a fake profile
  reference (auth failures are never charged to a quota).
- `developer_quota_counters` — per `(user_id, UTC day)` counter, the atomic
  source of truth for used/remaining.

### 4.2 Atomic quota claim (§69-§70)

Quota is **per user**; keys only attribute — creating N keys never
multiplies quota. Claims are an upsert that serializes on the primary-key
row lock:

```sql
insert into developer_quota_counters (user_id, period_start, units)
select ... where units <= limit
on conflict (user_id, period_start) do update
  set units = counters.units + excluded.units
  where counters.units + excluded.units <= limit
returning units   -- empty when the claim would exceed the limit
```

Concurrent same-user claims can never push past the limit (verified: 5
concurrent claims with limit 3 → exactly 3 pass, e2e §114).

### 4.3 Metering & headers (§73, §80)

- Successful metered requests record a `SUCCESS` event with units/cache/
  work/latency/scope; quota-exceeded requests record `REJECTED` with the
  real user attribution; auth-failed requests record `REJECTED` with NULL
  user (audit trail preserved, quota untouched).
- Rate limiting: per-route `DEVELOPER_RATE_LIMIT_PER_MINUTE` (default 60)
  on `/v1/developer/status` and `/v1/developer/usage` (global baseline 120/min
  also applies). Quota ≠ rate limit: distinct error codes.
- Headers on developer responses:
  `X-RateLimit-Limit/Remaining/Reset` (per-minute velocity) and
  `X-Quota-Limit/Remaining/Reset` (daily quota, UTC).

## 5. Endpoints (Block 1)

| Method | Path | Auth | Scope |
|---|---|---|---|
| GET | `/v1/developer/status` | API key | — (any scope) |
| POST | `/v1/developer/keys` | product session | — |
| GET | `/v1/developer/keys` | product session | — |
| POST | `/v1/developer/keys/:id/revoke` | product session | — |
| POST | `/v1/developer/keys/:id/rotate` | product session | — |
| GET | `/v1/developer/usage` | API key | `usage:read` |

Kill switch: `ENABLE_DEVELOPER_API=false` → 403 `FEATURE_DISABLED` (before
auth, so disabled surfaces cost nothing).

## 6. Verification (final)

| Suite | Result |
|---|---|
| `pnpm -r typecheck` | clean |
| `pnpm -r build` | 18/18 packages |
| `pnpm -r test` | 318 pass, 0 fail (12 suites) |
| `apps/api` developer tests (`developer-keys` + `developer-api`) | 14/14 |
| `apps/api` server tests | 6/6 |
| `test:e2e-d6-block1` (clean state: reset → migrate 0001..0006 → seed → flows) | 42/42 |
| `test:e2e-d5` | 18/18 |
| `test:correlation` (golden) | 31/31 |
| `test:correlation-dataset` (FP matrix) | 27/27 |
| `test:monitors` (golden) | 9/9 |
| `test:e2e-monitor` | 14/14 |
| `test:correlation-block2` | 22/22 |
| `test:account-classification` | 14/14 |

## 7. Bugs Found & Fixed (during verification)

1. **Revoked/expired keys reported `INVALID_API_KEY` instead of
   `REVOKED_API_KEY`**: `findActiveByPrefix` filtered status before hash
   verification, so revoked rows were invisible to auth. Fixed: auth looks up
   by prefix with any status (`findByPrefix`), verifies the hash, then checks
   status/expiration — revoked/expired keys now get a specific code, and
   callers never learn whether a prefix exists without a valid key.
   `findActiveByPrefix` remains for non-auth callers (active-key counts).
2. **Unit test `uniqueKey` built a prefix longer than 17 chars**, so the
   stored prefix never matched the auth slice (always `INVALID_API_KEY`).
   Fixed: the fixed slot is exactly 6 base58 chars (total 17) and the random
   tail comes from a real generated key.
3. **`record` with empty-string `userId`/`apiKeyId` for unauthenticated
   rejections violated the `uuid`/`bigint` columns** (silently swallowed by
   `.catch`). Fixed: `user_id` nullable in migration 0006, `record` accepts
   `null`, and reject events are written with NULL attribution.
4. **Unit test "no Authorization header" asserted a global counter of 0**,
   which is inherently racy (other tests legitimately claim quota in
   parallel). Fixed: the assertion is user-scoped (reject event with NULL
   user exists; no quota counter with NULL user).
5. **`debug-repro.ts`** (temporary debug harness) was updated to the new
   prefix/hash model; it is not part of the shipped surface.

## 8. Known Limitations

- Only key management + status + usage are exposed; D1-D5 intelligence
  endpoints (analysis, compare, x-ray, monitors) are NOT developer-exposed
  yet — D6-E does that with the same auth/quota scaffolding.
- Quota is a flat per-user daily unit count; per-endpoint cost weights are
  deferred until intelligence endpoints are exposed.
- `last_used_at` is throttled (1 write/min) so activity timestamps are
  approximate.
- Saved comparison `stale` flag relies on the analysis freshness window;
  refresh is an explicit user action (frontend), never automatic.
- RLS policies rely on `auth.uid()`; locally stubbed to NULL (same pattern
  as 0002), so unauthorized contexts match nothing.

## 9. Production Configuration (Block 1)

```env
# D6-A
ENABLE_SAVED_COMPARISONS=true

# D6-B..D6-D
ENABLE_DEVELOPER_API=true
MAX_ACTIVE_API_KEYS_PER_USER=10
API_KEY_DEFAULT_TTL_DAYS=0          # 0 = no expiration (set per key on create)
DEVELOPER_RATE_LIMIT_PER_MINUTE=60
DEVELOPER_DAILY_QUOTA=500
```

All kill switches default ON; disabling a surface never breaks the D1-D5
product (same pattern as `ENABLE_MONITORING`).

## 10. Cost Observations

- Saved comparison list/detail: 1-2 DB queries (bookmark + optional join
  snapshot); detail reuses the Redis comparison cache when present and
  rebuilds from persisted analyses otherwise — never triggers new analysis.
- Developer auth: 1 indexed prefix lookup + 1 constant-time hash + throttled
  touch; no scans, no per-request secrets in logs (prefix truncated,
  request_id preserved).
- Quota claim: single atomic upsert; summary: 2 queries (counter + event
  breakdown for the day).
- Rejected auth costs: 1 audit insert with NULL attribution, 0 quota.

## 11. D6 Direction (next blocks)

- **D6-E**: expose bounded intelligence endpoints (`/v1/developer/analyses`,
  `/v1/developer/compare`) behind the same auth/scopes/quota with
  per-operation cost weights and cache-first semantics.
- **D6-F**: commonality index from analyzed population statistics (not
  full-chain indexing) to sharpen hub penalties and semantic coverage.
- Monitor-driven correlation alerts reusing saved comparisons as the
  interest set.
