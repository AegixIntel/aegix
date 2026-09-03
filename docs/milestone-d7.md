# Milestone D7 — Public Product, Website, Full Feature Integration & Multi-User Launch

Authoritative D7 completion report. D7 is a pure product/frontend milestone: it turns the D1–D6 backend (intelligence engines, authentication, monitoring, developer infrastructure, security model) into a complete public-facing product. **No backend intelligence behavior was changed.** Where the backend already implemented a capability, D7 connected it through a real UI and proved it under concurrent users.

```text
USER → UI → AUTH/ADMISSION → API → CACHE/QUEUE/DB → INTELLIGENCE ENGINE → RESULT → UI
```

D7 ships in a single funded workstream (the public product build) plus validation (E2E, load, failure) and closure.

---

## 1. Production build repair (D7-A)

### Root cause of the build warnings
Both pre-existing web-build warnings came from importing the **aggregator**
`@solana/wallet-adapter-wallets`:

- `Module not found: Can't resolve 'pino-pretty'` — traced to
  `@walletconnect/logger` → `pino` → a conditional `require('pino-pretty')`
  that webpack follows because the aggregator pulled in the whole
  WalletConnect stack.
- `Critical dependency: the request of a dependency is an expression` —
  traced to `@reown/appkit` → `viem` → `ox/tempo`'s dynamic wasm import.

AEGIX only uses **Phantom** and **Solflare**. The fix was to import the
two adapters directly (`@solana/wallet-adapter-phantom`,
`@solana/wallet-adapter-solflare`) and **remove the aggregator**, so webpack
no longer traverses the WalletConnect graph. The `auth.tsx` behaviour is
unchanged; only the import source changed.

### Result
`pnpm -r typecheck`, `pnpm -r test`, and `pnpm --filter @aegix/web build`
all pass, and the web production build now compiles **with no warnings**.
The reported D6 "`<Html>`" failure was already resolved by D6; D7 confirmed
the production build is clean and recorded it as the baseline.

---

## 2. Public landing page (D7-B)

Route `/` is now a fully SSR marketing surface (not client-rendered). It is
built from server components and only the interactive dialog shell is a
client component.

Sections (in order):
1. **Navbar** — logo, Product / Intelligence / Developers / Methodology /
   Docs, and a **Launch App** CTA. Sticky, tasteful, mobile hamburger.
2. **Hero** — "Know What the Blockchain Knows." with supporting copy,
   primary CTA `Analyze Your Wallet` → `/app/analyze`, secondary
   `Compare Wallets` → `/app/compare`, tertiary `Explore Methodology`.
   Visual: the real Wallet X-Ray dashboard asset.
3. **Product principle strip** — `EVIDENCE FIRST` / `CONFIDENCE QUANTIFIED`
   / `LIMITATIONS EXPOSED`, plus **Correlation ≠ Ownership ≠ Identity**.
4. **Product** — Wallet X-Ray, Attack My Wallet, Compare Wallets, Privacy
   Monitor cards, each with a real CTA.
5. **Intelligence engine** — deterministic pipeline diagram
   (`ON-CHAIN DATA → NORMALIZATION → SIGNALS → CORRELATION → GRAPH →
   EXPOSURE`), the 7 X-Ray dimensions, and engine features.
6. **Developer infrastructure** — "Intelligence is Infrastructure." with the
   server asset.
7. **Vision** — Market / Reputation / ecosystem assets used **only** as
   aspirational vision, each explicitly marked "not yet a live product" per
   the product-truth rule (§24). No unsupported feature is presented as live.
8. **Final CTA** and **footer** (Product / Developers / Research / AEGIX),
   no dead social links.

### Asset mapping (copied into `apps/web/public/assets/`, originals untouched)
| Asset | Semantic filename | Use |
|---|---|---|
| `photo_…12-49-06` | `aegix-institutional-trust.jpg` | Not used on the live landing; institutional/vision |
| `photo_…12-49-11` | `aegix-intelligence-overview.jpg` | Vision |
| `photo_…12-49-22` | `aegix-intelligence-layer.jpg` | Vision (intelligence layer) |
| `photo_…12-49-25` | `aegix-wallet-intelligence.jpg` | **Hero + OG image** (real product) |
| `photo_…12-49-29` | `aegix-market-structure.jpg` | Vision only (Market — aspirational) |
| `photo_…12-49-38` | `aegix-intelligence-infrastructure.jpg` | Developer section |
| `photo_…12-49-41` | `aegix-ecosystem-vision.jpg` | Vision only |

### SEO / metadata
- `title`, `description`, `canonical`, OpenGraph + Twitter card, favicon
  (`/icon`), `robots.ts`, `sitemap.ts`.
- OG image uses `aegix-wallet-intelligence.jpg` (the actual product), not a
  generic crypto image.
- `metadataBase` set from `SITE_URL`; `robots` blocks `/app` and
  `/developers` from indexing.

---

## 3. Public information architecture (D7-C)

Audited existing routes and normalized to the D7 target map, keeping all
working routes and adding **compatibility redirects** (no rename broke a
bookmark).

```text
/
├── /app                       (authenticated shell)
│   ├── /analyze               Wallet X-Ray input
│   ├── /analyze/[wallet]      Wallet X-Ray report + live tracker
│   ├── /compare               Compare Wallets
│   ├── /dashboard             Saved intelligence aggregate
│   ├── /monitors              Privacy monitors
│   ├── /monitor/[id]          Monitor detail + events + alert rules
│   ├── /saved                 Saved analyses + comparisons
│   ├── /saved/[id]            Saved comparison detail
│   ├── /notifications         Inbox + verified notification-email config
│   └── /login                 Intent-return wallet-auth flow
├── /developers                Developer portal (API keys)
│   ├── /usage                 Metered quota
│   └── /webhooks              Webhook management
├── /docs                      Structured docs portal (sidebar)
├── /methodology               Methodology page
├── /security                  Security page
└── /status                    User-safe service status
```

Legacy routes now redirect: `/analyze/[wallet]` → `/app/analyze/[wallet]`,
`/compare` → `/app/compare`, `/dashboard` → `/app/dashboard`,
`/dashboard/monitor/[id]` → `/app/monitor/[id]`,
`/dashboard/notifications` → `/app/notifications`,
`/dashboard/saved-comparison/[id]` → `/app/saved/[id]`,
`/developer` → `/developers`.

---

## 4. Application shell (D7-D)

The authenticated app uses a shared shell with a collapsible sidebar:

- **Overview**: Wallet X-Ray, Compare, Monitors, Saved, Notifications.
- **Developer**: API Keys, Usage, Webhooks.
- **Account**: connected wallet + sign-out (from the auth widget).
- Mobile hamburger menu collapses the same nav.

The app is intentionally **data-first and dense** — it reuses the
established dark token set and keeps the visual weight on the intelligence,
distinct from the cinematic landing. Every app section has an explicit
empty, loading, and error state (no blank screens, no infinite spinners).

---

## 5. Wallet authentication UX (D7-E)

Reuses the D6 wallet-only auth machinery (`lib/auth.tsx`,
`auth-provider.tsx`). No crypto/auth logic was rewritten.

- **Wallet support**: Phantom + Solflare via the standard wallet-adapter
  architecture (no vendor hard-coding).
- **Copy**: "Signing does not create a transaction and costs no SOL."
- **Intent-return flow**: a protected action while unauthenticated stores
  the destination and redirects to `/app/login?returnTo=<original>`, then
  returns there after a successful sign-in. Used by the Save Comparison and
  Save Wallet buttons; the dashboard/monitors/developer surfaces gate with
  a connect CTA.
- **Intentional errors**: connection rejected, signature rejected,
  challenge expired, invalid signature, wallet switched, wallet
  disconnected, server unavailable — surfaced via the existing auth error
  state.

---

## 6. Wallet X-Ray (D7-F)
## 7. Attack My Wallet (D7-G)
## 8. Compare (D7-H)
## 9. Monitors / notifications / email (D7-I)
## 10. Saved + dashboard (D7-J)

These are grouped because they share one integration approach: **real
backend endpoints, no frontend mock data**.

- **Wallet X-Ray** (`/app/analyze/[wallet]`) renders score, confidence,
  data-quality grade + semantic coverage, the 7 dimension scores, top
  findings with an evidence explorer, attack paths, potential correlations,
  and engine versions. It uses a **live analysis tracker** that maps real
  backend stages (CREATED → QUEUED → FETCHING → NORMALIZING → … → READY)
  and never fakes progress. Deterministic/backend explanation fields only —
  no LLM prose is generated.
- **Attack My Wallet** distinguishes **OBSERVED** (solid) from **INFERRED**
  (dashed) edges with labels and a legend, and exposes a bounded set of path
  results with a mobile-friendly list fallback.
- **Compare** (`/app/compare`) shows correlation **strength** and
  **confidence** as separate metrics, evidence families, "why it may matter"
  vs "why it may be misleading", population commonality (AEGIX-observed
  population, not global Solana), relationship paths, and cluster context.
  The frontend preserves the canonical pair identity `(A,B)==(B,A)` for
  server calls and saved-comparison dedup.
- **Monitors** (`/app/monitors`, `/app/monitor/[id]`) allow create / view /
  pause / resume / delete via real APIs, show wallet, status, last analysis,
  next check, baseline, latest exposure, recent changes, alert rules, and a
  threat-event feed with acknowledge.
- **Notifications** (`/app/notifications`) render the IN_APP inbox with
  type / severity / wallet / timestamp / read state and mark-read, plus a
  **verified notification-email** config (set email → 6-digit code → verify
  → eligible for EMAIL). "Email ≠ authentication" is stated explicitly.
- **Saved + dashboard** aggregate saved analyses, saved comparisons, active
  monitors, and recent notifications. Saved comparisons support
  save / unsave / label / notes / list / open / delete, and respect the
  historical-result semantics from D6-A (never auto-triggers re-analysis).

---

## 11. Developer portal (D7-K)

- `/developers` — create key (name, scopes, optional expiration), one-time
  plaintext secret display, list (prefix only), revoke, rotate. Secrets are
  never shown again.
- `/developers/usage` — period / used / limit / remaining / reset /
  per-operation breakdown, with a usage bar. **Rate limit** and **quota**
  are described as distinct concepts.
- `/developers/webhooks` — create endpoint, select events, one-time signing
  secret, status / last success / last failure / failure count, test,
  rotate secret, disable/re-enable, delete, and a direct link to signature
  verification docs. All backed by the real D6 webhook routes.

---

## 12. Documentation portal (D7-L)

`/docs` is a structured, navigable experience with a fixed sidebar
(Getting Started, Product, Intelligence, Methodology, Developer API,
Webhooks, Security) rather than a single markdown dump. Source of truth is
the real repo docs (`architecture.md`, `docs/milestone-d*.md`,
`docs/webhooks.md`) and the actual API contracts. Code examples match real
endpoint shapes (no fake curl output).

---

## 13. Methodology / security / status (D7-M)

- `/methodology` — raw activity → normalization → signals → evidence →
  correlation → confidence → exposure, a strength-vs-confidence section,
  and conceptual false-positive controls (common-hub penalty, population
  commonality, dust filtering, sample adequacy, semantic coverage,
  single-family caps) without exposing security-sensitive internals.
- `/security` — wallet-only auth, signMessage (no transaction, no private
  keys), domain-bound challenges, session security, API-key handling,
  webhook signatures.
- `/status` — user-safe service state from `GET /health/ready`; never leaks
  credentials or internal topology.

---

## 14. Multi-user concurrency & isolation (D7-N)

Blockers investigated in `pnpm loadtest:public` (see §D7-S). Key facts:

- **Shared intelligence**: multiple users analyzing the same public wallet
  reuse the same cached/deduped analysis via the D1–D6 cache + dedup
  infrastructure — the browser never performs heavy RPC work.
- **Private ownership**: shared intelligence results do not imply shared
  private resources — a saved reference belongs to one user and is
  isolated from others.
- **Cross-user isolation** is verified by the E2E (flow 9): user B cannot
  read user A's saved comparisons, monitors, or webhooks; private detail
  routes return 404/empty.
- **Returning user** (E2E flow 10): re-login with the same wallet resolves
  the same internal user and preserves saved data.

---

## 15. Public admission / abuse / cost protection (D7-O)

The D3/D5/D6 admission pipeline is preserved and no browser-driven heavy
work is introduced. Public load is bounded by:

- `validate → classify → cache/reuse → quota/admission → dedup → new work`.
- Global baseline rate limit (120/min) plus per-route limits: wallet-auth
  challenge/verify, analysis, compare, developer.
- Daily quota with distinct anonymous vs authenticated bounds
  (`FREE_ANON_DAILY_LIMIT` / `FREE_USER_DAILY_LIMIT`).
- Queue admission (`MAX_QUEUE_DEPTH`, `MAX_ACTIVE_GLOBAL`,
  `MAX_PENDING_PER_USER`, `MAX_PENDING_PER_IP`).
- `ENABLE_NEW_ANALYSES` / feature-flag kill switches.
- Cost observability: anonymous X-Ray is preserved as a **bounded**
  capability; the browser never issues uncontrolled RPC calls.

---

## 16. Responsive / accessibility / performance / SEO (D7-P)

- **Responsive**: tested breakpoints via responsive grids; hero imagery
  uses `object-cover` with intentional crop rather than naive shrinking.
- **Accessibility**: semantic headings (single `h1` per page, correct `h2`/
  `h3` hierarchy), keyboard nav + `aria-expanded` on toggles, focus-visible
  outlines, labelled inputs/forms, `prefers-reduced-motion` respected,
  alt text on every image, and redundant cues for observed/inferred edges
  (not color alone).
- **Performance**: `next/image` optimization + lazy loading for below-fold
  cinematic assets; the marketing page is SSR.
- **SEO**: title/description/canonical/OG/Twitter/favicon/robots/sitemap.

---

## 17. Production deployment readiness (D7-Q)

- Production target `ENABLE_LEGACY_SUPABASE_AUTH=false` is met — the web
  frontend has no Supabase/Legacy dependency; the existing config tests
  enforce fail-fast on missing `WEBHOOK_ENCRYPTION_KEY`, SMTP host,
  localhost auth domain, and production `WEBHOOK_DEV_ALLOW_PRIVATE`.

---

## 18. Public product E2E (D7-R)

`pnpm test:e2e-d7` drives the real Fastify server via `app.inject()` against
a clean state (reset → migrate → seed) and covers all D7 flows:

1. New-user wallet auth (challenge → sign → verify → me, replay + wrong-domain rejected)
2. Anonymous analysis admission (eligible + gated, invalid → 400, non-eligible → not analyzable)
3. Wallet X-Ray (score/confidence distinct, dimensions, signals, attack paths, engines)
4. Compare (strength/confidence, evidence families, paths, clusters, commonality, canonical pair, self-compare rejected)
5. Save comparison (create/list/patch/detail + stale flag)
6. Monitor + notification + verified email (create/get/patch, in-app read, wrong code rejected, max-attempt limit)
7. Developer API (create/list/status/rotate/revoke)
8. Webhooks (create/test/rotate/disable/delete, signature verify valid + tampered, SSRF blocked)
9. Cross-user isolation
10. Returning user (same userId, data persists)

Result: **68 assertions, 0 failures** (deterministic).

---

## 19. Load / failure / multi-user validation (D7-S)

`pnpm loadtest:public` runs bounded, offline scenarios (see §D7-N for the
multi-user/dedup results). Failure-injection (Redis down, RPC down, DB down,
worker down, SMTP down, webhook failing) is covered by the existing
`e2e-d6`/`e2e-monitor` suites and the webhook SSRF/failure harness, which
remain green.

---

## 20. Feature connectivity matrix

| Feature | UI route | API | Auth | Backend engine | Persistence | E2E status |
|---|---|---|---|---|---|---|
| Wallet X-Ray | `/app/analyze/[wallet]` | `POST /v1/analyses`, `GET /v1/wallets/:addr/x-ray` | Public (bounded) | normalizer → intelligence → scoring → graph | `analysis_jobs`, intelligence tables | ✔ flow 3 |
| Privacy Exposure Score | `/app/analyze/[wallet]` | `GET /v1/wallets/:addr/x-ray` | Public | `packages/scoring` | persisted | ✔ flow 3 |
| 7 Dimensions | `/app/analyze/[wallet]` | same x-ray | Public | intelligence | persisted | ✔ flow 3 |
| Signals + Evidence | `/app/analyze/[wallet]` | same x-ray | Public | intelligence/explanation | persisted | ✔ flow 3 |
| Confidence / Data Quality / Semantic Coverage | `/app/analyze/[wallet]` | same x-ray | Public | scoring/normalizer | persisted | ✔ flow 3 |
| Attack My Wallet (multi-hop graph) | `/app/analyze/[wallet]` | same x-ray | Public | `packages/graph` | persisted | ✔ flow 3 |
| Compare (cross-wallet correlation) | `/app/compare` | `POST /v1/compare`, `GET /v1/compare/:pairId` | Public (bounded) | `packages/correlation` | `correlation` | ✔ flow 4 |
| Funding Provenance | x-ray + compare | x-ray / compare | Public | intelligence | persisted | ✔ flow 3/4 |
| Behavioral Similarity | x-ray + compare | x-ray / compare | Public | intelligence | persisted | ✔ flow 3/4 |
| Temporal Correlation | compare | compare | Public | correlation | persisted | ✔ flow 4 |
| Entity Intelligence | x-ray | x-ray | Public | entity registry | persisted | ✔ flow 3 |
| Cluster Hypothesis | compare | compare | Public | graph/correlation | persisted | ✔ flow 4 |
| Population Commonality | compare | compare | Public | commonality | `population_observation_stats` | ✔ flow 4 (fallback verified) |
| Privacy Monitor (exposure diff) | `/app/monitors`, `/app/monitor/[id]` | `/v1/me/monitors*` | Wallet session | `packages/monitor` + diff | `monitors`, `threat_events` | ✔ flow 6 |
| Correlation Alerts | monitor detail | `/v1/me/monitors/:id` | Wallet session | correlation + diff | persisted | ✔ flow 6 |
| Threat Events | monitor detail | `/v1/me/monitors/:id/events`, acknowledge | Wallet session | monitor | `threat_events` | ✔ flow 6 |
| Alert Rules | monitor detail | `PATCH /v1/me/monitors/:id` | Wallet session | monitor | `monitor_alert_rules` | ✔ flow 6 |
| Notifications (in-app) | `/app/notifications` | `/v1/me/notifications` | Wallet session | monitor/notification | `notifications` | ✔ flow 6 |
| Verified Email | `/app/notifications` | `/v1/me/email`, `/verify` | Wallet session | profile + email | `profile` | ✔ flow 6 |
| Saved Analyses | `/app/saved`, `/app/dashboard` | `/v1/me/saved` | Wallet session | saved repo | `saved_wallets` | ✔ flow 5 |
| Saved Comparisons | `/app/saved`, `/app/dashboard`, `/app/saved/[id]` | `/v1/me/saved-comparisons*` | Wallet session | saved-comparison repo | `saved_comparisons` | ✔ flow 5 |
| Wallet Auth | `/app/login` | `/v1/auth/wallet/*` | Public | `wallet-auth.ts` | session hash | ✔ flow 1 |
| Developer API Keys | `/developers` | `/v1/developer/keys*` | Wallet session | `developer-keys.ts` | `developer_api_keys` | ✔ flow 7 |
| Developer Scopes | `/developers` | `POST /v1/developer/keys` | Wallet session | developer-keys | persisted | ✔ flow 7 |
| Developer Quota | `/developers/usage` | `POST /v1/developer/intelligence/*`, `/usage` | API key | developer-usage | `developer_usage_events` | ✔ flow 7 |
| Usage Metering | `/developers/usage` | `GET /v1/developer/usage` | API key | developer-usage | persisted | ✔ flow 7 |
| Webhooks | `/developers/webhooks` | `/v1/webhooks*` | Wallet session | `webhook-delivery` | `webhooks` | ✔ flow 8 |
| Webhook Verification | `/docs/webhooks/verification` | (consumer side) | — | `@aegix/webhook-delivery` | — | ✔ flow 8 |

---

## 21. Final feature audit

Every user-facing D1–D6 feature is now reachable through a **PUBLIC UI**; none
remains unexpectedly **INTERNAL ONLY**. The developer-intelligence namespace
(`/v1/developer/intelligence/*`) is a developer-facing API surface (correctly
**DEVELOPER API**, not public product UI), exposed through the developer
portal and documented. It is intentionally not a marketing/consumer surface.

---

## 22. Security release-blocker review

- Wallet-auth spoof/replay — prevented by nonce + domain binding + one-time
  challenge consumption (verified by E2E flow 1). ✅
- Cross-user private data access — isolated (E2E flow 9). ✅
- API key leak — keys shown once, hash-only at rest, prefix-only in list. ✅
- Webhook secret leak — shown once, AES-256-GCM at rest. ✅
- Webhook SSRF — private/loopback/link-local blocked (E2E flow 8), redirects
  never followed. ✅
- Quota bypass / uncontrolled work — admission pipeline + daily quota +
  queue depth, browser never does heavy RPC. ✅
- Unsafe production config — fail-fast config guardrails. ✅
- Production build failure — web build passes with no warnings. ✅

---

## 23. Known limitations

- **Notification-email verification code** is only printed to the console
  provider in dev; E2E asserts wrong-code rejection and the bounded
  max-attempt limit rather than reading the code back from logs.
- **Webhook `/test`** enqueues async delivery (needs a worker); E2E asserts
  `queued: true` and verifies delivery semantics separately via
  `verifyWebhookRequest` / `resolveWebhookDestination`.
- **Vision assets** (Market/Reputation) are presented as aspirational only;
  they never imply a live feature.
- **Legend**: the `tests/` directory has no `package.json` with
  `"type": "module"`, so running `tsc` over it directly reports the
  pre-existing `TS1295` (module-format) artifact; tests run correctly via
  `tsx`, identical to the existing `tests/e2e-d6.ts`.
- **Environment-only limitation (documented, not a code defect)**: the local
  CI/dev shell runs with `NODE_ENV=production`, which makes `loadConfig()`
  fail-fast on the default localhost `DATABASE_URL`. Harnesses that hit the
  config guard (e.g. `e2e-d6`, `golden-monitors`) must be run with
  `NODE_ENV=test` (as `e2e-d7` and `developer-api.test.ts` already do). With
  `NODE_ENV=test` these suites are green: `e2e-d6` (51/51),
  `e2e-d6-block1` (42/42), `e2e-d6-block2` (36/36), `e2e-monitor` (14/14),
  `golden-correlation` (31/31), `golden-monitors` (9/9),
  `account-classification` (14/14). No code was weakened to obtain green.
- **Load-test DB**: `loadtest:public` uses a dedicated `aegix_loadtest`
  database (created once) so it never clobbers the shared `aegix` /
  `aegix_test` databases used by the pull-based E2E suites.

## 24. Git log / commits

D7 commits:
- `ada9742` — feat(web): D7 public product frontend — landing, app shell, docs, developer portal.
- `16c88ea` — test: D7 public product E2E, load harness, and milestone doc
  (`test:e2e-d7` 68/68, `loadtest:public` all scenarios PASS, `docs/milestone-d7.md`).
