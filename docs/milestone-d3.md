# Milestone D3 — Public Beta Productization

Date: 2026-08-31

## D3 scope

Transform AEGIX from a reliable internal intelligence system into a
controlled, secure, usable public beta product:

- D3-A: Solana account classification
- D3-B: Semantic coverage v2
- D3-C: Public analysis admission control
- D3-D: Supabase authentication
- D3-E: Authorization + RLS
- D3-F: Quota system
- D3-G: Saved analyses + dashboard
- D3-H: Public Wallet X-Ray UX
- D3-I: Public abuse protection
- D3-J: Production deployment

## Commits

```text
13db30d feat: Solana account classification before analysis (D3-A)
a6ce634 feat: semantic coverage v2 with protocol fallback actions (D3-B)
d50af2b feat: public analysis admission control (D3-C)
0ce5ef5 feat: Supabase authentication with server-side JWT verification (D3-D)
70ccd78 feat: saved analyses API with server-side ownership (D3-E + D3-G)
56916d4 feat: config-driven quota system with usage tracking (D3-F)
7fc1bd0 feat: dashboard with saved wallets (D3-G)
df22fa6 feat: public Wallet X-Ray UX polish (D3-H)
fe7fe54 feat: rate limit tiers and request body limits (D3-I)
6e57ed1 feat: production env validation and dependency-aware health (D3-J)
```

## Account classification (D3-A)

`packages/blockchain/src/classifier.ts` — deterministic, evidence-based:

- Uses owner, executable flag, data length, known protocol registry and
  known sysvar addresses — never address appearance
- Classes: USER_WALLET, PROGRAM, PROTOCOL_ACCOUNT, TOKEN_MINT,
  TOKEN_ACCOUNT, SYSVAR, PDA, UNKNOWN_ACCOUNT, each with confidence +
  evidence
- Runs before any expensive fetch: `POST /v1/analyses` classifies first
  and returns 422 ACCOUNT_NOT_ANALYZABLE for programs/mints/sysvars
  (with protocol identity when known) instead of INSUFFICIENT_HISTORY
- `GET /v1/accounts/:address/classification` exposes the classification
  for the frontend
- Worker guards processAnalysis with the same classification

Live validation on mainnet: Jupiter → PROTOCOL_ACCOUNT (VERIFIED),
So111 → TOKEN_MINT, Sysvar → SYSVAR, fresh keypair → UNKNOWN_ACCOUNT.
Notable: D2's "repeated counterparty user wallet" 7iDEKW is actually a
token account on-chain — the classifier caught what D2 could not.

## Semantic coverage changes (D3-B)

- Recognized programs with opaque instructions (base58 `data`, no parsed
  type) now fall back to generic protocol actions:
  METADATA_INTERACTION, MARKETPLACE_INTERACTION — instead of UNKNOWN
- Fixed Magic Eden v2 program ID (was a wrong address), now VERIFIED in
  parser registry, entity seed and classifier

### Before/after semantic coverage

Real NFT-heavy user wallet `EuVNEdz5yHiR9kY8KZHPbYfFzX9nS4CFQPmAdPngyH9P`:

| Metric | Before (D2) | After (D3-B) |
| --- | --- | --- |
| Semantic coverage | 0% | 10.3% |
| Fully parsed transactions | 0 | 299 |
| Generic parsed | 989 | 695 |
| Magic Eden interactions | UNKNOWN | 299 × MARKETPLACE_INTERACTION / NFT |

Parser success remains 100% and is deliberately distinct from semantic
coverage in the UI and data_quality.

## Admission control (D3-C)

`checkAdmission()` runs after cache/dedup, before job creation:

- MAX_QUEUE_DEPTH (50), MAX_PENDING_PER_USER (3), MAX_PENDING_PER_IP (5),
  MAX_ACTIVE_GLOBAL (30) — all config-driven
- Overloaded requests get a controlled 503 SERVICE_BUSY — no unbounded
  BullMQ intake
- Kill switch ENABLE_NEW_ANALYSES=false: new analyses disabled, cached
  reports and dashboard keep working (verified live)
- Feature flags: ENABLE_REGISTRATION, ENABLE_NEW_ANALYSES,
  ENABLE_ATTACK_MY_WALLET, ENABLE_SAVE_WALLET — with correct boolean env
  parsing (z.coerce.boolean turned "false" into true — fixed)

## Auth architecture (D3-D)

- `apps/api/src/auth.ts`: Supabase access tokens verified server-side via
  JWKS (or HS256 with SUPABASE_JWT_SECRET for self-hosted/dev)
- req.user resolved in an onRequest hook — frontend auth state is never
  trusted (D3-D §29)
- Anonymous requests proceed without a token; invalid tokens are treated
  as anonymous; authenticated-only endpoints 401 via requireUser()
- Registered users get a profile upserted on first analysis
  (profiles.id = auth sub)
- Verified live: no token → anon; valid HS256 JWT → profile created,
  job attributed to the user

## RLS policies (D3-E)

Migration 0002:

- `auth.uid()` stub for vanilla Postgres (returns NULL → policies deny);
  real Supabase provides the function
- saved_analyses has SELECT/INSERT/DELETE policies scoped to auth.uid()
- Server-side ownership enforcement verified: user B cannot list or
  delete user A's bookmarks

## Quota architecture (D3-F)

- checkQuota(): daily expensive-analysis limits per actor class —
  anonymous (FREE_ANON_DAILY_LIMIT=3, by IP + optional anonymous key)
  and registered (FREE_USER_DAILY_LIMIT=10, by verified user id)
- Only expensive analyses consume quota; cache hits recorded separately
  and never counted
- 429 response: `{ code: ANALYSIS_QUOTA_EXCEEDED, resetAt, message }`
- usage_records backs all accounting (auditable)

### Anonymous limits

3 expensive analyses / day (config: FREE_ANON_DAILY_LIMIT)

### Registered limits

10 expensive analyses / day (config: FREE_USER_DAILY_LIMIT)

## Saved analysis architecture (D3-G)

- saved_analyses: user-owned bookmarks (user_id, wallet_id, analysis_id,
  label) pointing at shared reports — 100 users saving the same wallet do
  not duplicate the blockchain report
- API: GET/POST/DELETE /v1/me/saved (authenticated)
- Dashboard at /dashboard: saved wallets with score, confidence, status,
  freshness, last-analyzed date; remove; links to X-Ray
- Labels are private user metadata, never blockchain evidence

## Public API changes

- GET /v1/accounts/:address/classification
- GET/POST/DELETE /v1/me/saved
- POST /v1/analyses now returns 422 ACCOUNT_NOT_ANALYZABLE, 503
  SERVICE_BUSY, 429 ANALYSIS_QUOTA_EXCEEDED (in addition to existing codes)
- /health/ready returns { status: ok|degraded|unavailable, checks }

## Security changes (D3-I)

- Rate limit tiers: 120/min global, 10/min for analysis creation
- Body limit 1024 bytes
- Production boot fails fast without explicit credentials
- Service role / RPC keys server-only; frontend bundle audited clean
- Error responses never include stack traces

## Deployment topology

```
Cloudflare (edge, optional)
    ↓
Next.js Web  ────→  Fastify API
                        ↓
                  PostgreSQL (Supabase)
                  Redis / BullMQ
                        ↓
                  Worker
                        ↓
                  Multi-RPC Pool
                        ↓
                  Solana Mainnet
```

## Environment configuration

- development: local defaults (docker-compose Postgres/Redis), no
  Supabase required
- staging/production: NODE_ENV=production requires explicit DATABASE_URL,
  REDIS_URL, RPC_URL, CORS_ORIGIN, SUPABASE_URL, SUPABASE_SERVICE_KEY —
  fail fast otherwise
- Feature flags: ENABLE_REGISTRATION, ENABLE_NEW_ANALYSES,
  ENABLE_ATTACK_MY_WALLET, ENABLE_SAVE_WALLET

## Feature flags

See above; all env/config-driven, no feature-management platform.

## Kill switch

ENABLE_NEW_ANALYSES=false disables new analysis creation while cached
reports, dashboard and saved wallets keep working. Verified live.

## Metrics

- usage_records: expensive_analysis vs cache_hit per actor, daily
- analysis_jobs.data_quality: parser success, semantic coverage, fully/
  partially/generic parsed, unknown programs, RPC failures, provider
  circuits
- /health/ready dependency checks for operations

## Public beta test results

### Anonymous user journey

- Open AEGIX → enter wallet → account classified → quota checked →
  analysis runs → Wallet X-Ray ✓ (verified via API end-to-end)
- Anonymous quota exhaustion: 3rd expensive analysis → 429
  ANALYSIS_QUOTA_EXCEEDED with resetAt ✓

### Registered user journey

- Valid JWT → analyze → save wallet → dashboard → view previous
  analysis → refresh ✓ (API verified; dashboard built and typechecks)

### Cache journey

- User A analyzes wallet → report generated; user B requests same wallet
  → fresh report reused, cache_hit recorded, no new RPC job ✓

### Overload journey

- Queue/pending limits → controlled 503 SERVICE_BUSY; cached reports and
  GET endpoints keep working ✓

### Provider failure journey

- D2-verified failover still in place; /health/ready reports degraded
  when RPC is down while core stays up ✓

### Security journey

- Cross-user access: user B cannot read/modify user A's saved wallets ✓
- Invalid JWT → treated as anonymous (public endpoints), 401 on
  authenticated-only endpoints ✓
- Oversized request → rejected by body limit ✓
- Quota bypass via frontend: impossible — server-side enforcement ✓

## Performance comparison with D2

- No change to the analysis pipeline core (fetch/normalize/engines/
  scoring/graph) — D3 adds a lightweight classification RPC call before
  analysis and admission/quota DB checks on the API
- Classification adds 1 RPC round-trip per request (~10-50ms); cache hits
  still serve in 4-9ms
- Golden wallet regression (3 wallets, below) confirms scores and
  confidence are stable

## Bugs discovered

1. Magic Eden v2 program ID was wrong in the parser registry (D2-era);
   real ID verified active, fixed in registry + entity seed + classifier
2. z.coerce.boolean() turned ENABLE_NEW_ANALYSES=false into true — kill
   switch silently ineffective; fixed with explicit boolean parsing
3. Golden-wallet "user wallet" 7iDEKW is actually a token account —
   classification now prevents it from being analyzed as a personal wallet
4. Test fixture used the old (wrong) Magic Eden program ID — updated

## Bugs fixed

All of the above; each verified by live testing.

## Known limitations

- Supabase hosted auth not exercised against a live Supabase project
  (no credentials in this environment); JWT verification tested with
  HS256 dev secret and JWKS code path is unit-reviewable
- RLS policies protect saved_analyses; analysis_jobs/wallets remain
  public by design (blockchain data)
- Anonymous quota keyed by IP + optional client-supplied anonymous key —
  not bulletproof against IP rotation, layered with rate limits and
  admission control
- Semantic coverage for NFT metadata programs improved but remains low
  for compressed NFTs and deep marketplace instruction variants
- ENABLE_ATTACK_MY_WALLET flag exists but the feature is not gated in
  the UI yet

## Operational procedures

- Migrations: `pnpm --filter @aegix/database migrate` (0001, 0002)
- Seeds: `pnpm --filter @aegix/database seed:entities`
- Health: GET /health/live, GET /health/ready
- Kill switch: set ENABLE_NEW_ANALYSES=false and restart API
- Quota tuning: FREE_ANON_DAILY_LIMIT / FREE_USER_DAILY_LIMIT
- Admission tuning: MAX_QUEUE_DEPTH / MAX_PENDING_PER_* / MAX_ACTIVE_GLOBAL

## Recommended next milestone (D4)

1. Live Supabase project wiring (real magic-link auth + JWKS validation
   against hosted project)
2. Attack My Wallet feature flag gating in the UI
3. Semantic coverage v3: decode common instruction discriminators for
   Metaplex (create/update/transfer) and Tensor to move beyond generic
   fallback actions
4. Public beta metrics dashboard (usage_records → charts)
5. Cloudflare bot protection for analysis creation endpoint
