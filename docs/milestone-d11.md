# Milestone D11 — Billing & Entitlements

Written for: engineers working on this repository, and operators running the
deployment.

D11 implements the billing layer described in `architecture.md` §69, and the
plan-based limits described in §82. It adds no intelligence, changes no
score, and touches no analysis engine.

The central design constraint is that D11 is wired into live enforcement
points that every existing product surface already runs through. That is only
safe under one property:

> **The free plan is defined as the deployment's existing limits, so an
> identity without a subscription — which is every identity today — is
> enforced at exactly the numbers that were enforced before D11 existed.**

That property is asserted directly in
`packages/billing/src/entitlements.test.ts` and
`apps/api/src/billing.test.ts`, and it is what makes `ENABLE_BILLING=true` a
safe default.

---

## 1. What is and is not built

Built:

```text
plan catalog                    3 plans, derived from AppConfig
entitlement resolution          subscription state → enforced limits
subscription state machine      9 actions, 9 event types, pure
append-only billing ledger      every transition, idempotent by event key
usage metering                  7 dimensions over existing counters
invoice arithmetic              deterministic, integer cents
lifecycle sweep                 renewal, expiry, grace, invoice generation
HTTP surface                    /v1/billing/*
operator grant                  pnpm billing:grant
plan & usage UI                 /app/billing
```

Deliberately not built:

```text
payment processor integration   architecture.md PR-12: the beta operates
                                without payment infrastructure. The seam is
                                `PaymentProvider`; the only implementation is
                                `manual`.
self-serve upgrade              refused with PAYMENT_PROVIDER_REQUIRED while
                                no provider exists — see §6.
overage billing                 the arithmetic exists and is tested; the v1
                                catalog declares no overage rates because
                                every dimension is a hard cap.
proration                       a mid-period plan change takes effect
                                immediately and keeps the period; settlement
                                arrives with the payment provider.
tax, discounts, credits         `totalCents` is a separate field from
                                `subtotalCents` so adding them is not a
                                schema change.
```

Two limits named in the architecture are deliberately **not** entitlements:

- **Historical analysis depth** (§69 lists it as a usage dimension). A
  completed analysis is shared public blockchain data: one report per wallet
  serves every caller (D3-C §24). Making depth depend on the requester's plan
  would make a cached report depend on who paid for it. Depth stays a single
  engine-wide bound, `ANALYSIS_MAX_HISTORY_DAYS`.
- **Per-minute request rate** (§81). A burst limit is sized to what the
  deployment can absorb, not to what a customer bought. The plan-based part
  of §82 is the daily quota, and that *is* an entitlement.

Attack analysis is not a separate metered dimension either: "Attack My
Wallet" renders from the same completed analysis record as Wallet X-Ray and
creates no additional chain work.

---

## 2. Package layout

`@aegix/billing` is pure: no I/O, no environment, no database, no payment
SDK. It is the answer to §69's "keep billing isolated".

```text
packages/billing/src
├── types.ts         vocabulary: plans, entitlements, statuses, dimensions
├── catalog.ts       plan catalog derived from one baseline
├── entitlements.ts  subscription state + now → enforced limits
├── lifecycle.ts     the subscription state machine
├── apply.ts         decide-then-persist, over a store *port*
├── metering.ts      usage_type → dimension, dimension → entitlement
├── rollup.ts        storage counters → billing dimensions
├── invoice.ts       plan + usage → invoice lines, integer cents
├── period.ts        UTC period arithmetic
└── provider.ts      PaymentProvider seam; `manual` implementation
```

Persistence lives in `@aegix/database` (`repositories/billing.ts`), the HTTP
surface in `apps/api/src/billing.ts`, entitlement resolution for the API in
`apps/api/src/entitlements.ts`, and the lifecycle sweep in
`apps/worker/src/processors/billing.ts`.

`apply.ts` takes a `BillingStore` port rather than a repository. The API, the
worker sweep and the operator script all drive the same orchestration, so a
grant, a renewal and a self-serve change cannot diverge.

---

## 3. Plan catalog

The catalog is built from one baseline — the limits the deployment already
runs on — and scaled per family:

| Family | Entitlements | free | pro | team |
|---|---|---|---|---|
| DAILY | `analysis.daily`, `compare.daily`, `ask.daily`, `markets.daily`, `api.daily` | ×1 | ×10 | ×40 |
| LEVEL | `monitors.active`, `apiKeys.active`, `webhooks.active` | ×1 | ×5 | ×20 |

Concurrency scales more conservatively than throughput: an active monitor or
webhook holds platform resources continuously, while a daily quota only
spreads work over a day.

With the documented default config that is:

| Entitlement | free | pro | team |
|---|---|---|---|
| `analysis.daily` | 10 | 100 | 400 |
| `compare.daily` | 50 | 500 | 2000 |
| `ask.daily` | 25 | 250 | 1000 |
| `markets.daily` | 200 | 2000 | 8000 |
| `api.daily` | 500 | 5000 | 20000 |
| `monitors.active` | 3 | 15 | 60 |
| `apiKeys.active` | 10 | 50 | 200 |
| `webhooks.active` | 5 | 25 | 100 |

Prices: free `$0`, pro `$49/month`, team `$199/month`.

Two invariants hold by construction and are tested:

- **A zero baseline stays zero on every plan.** If a deployment switches a
  surface off (`MARKETS_DAILY_QUOTA=0`), no plan turns it back on.
- **The catalog is monotonic.** A higher tier never grants less of anything.
  `catalogViolations()` reports a breach; the API logs it loudly at startup
  and still serves, because resolution floors every plan at the free
  baseline, so nobody can end up worse off than a free identity.

---

## 4. Entitlement resolution

`resolveEntitlements(catalog, subscription, now)` is pure and total.

| Subscription state | Enforced plan |
|---|---|
| none | free |
| `TRIALING`, trial not yet over | subscribed plan |
| `TRIALING`, trial elapsed | free |
| `ACTIVE` | subscribed plan |
| `PAST_DUE`, inside grace window | subscribed plan |
| `PAST_DUE`, grace elapsed or absent | free |
| `CANCELED` (scheduled), period still running | subscribed plan |
| `CANCELED`, period ended | free |
| `EXPIRED` | free |

Three deliberate behaviours:

- **A late renewal is never a customer-visible downgrade.** An `ACTIVE`
  subscription whose period end has passed keeps its entitlements. A renewal
  job running late is our failure, not the customer's.
- **A stale row degrades on read.** An expired trial or a closed grace window
  resolves to free even if the lifecycle sweep has not run yet. The sweep
  makes the row agree with what is already being enforced; it is not what
  makes enforcement correct.
- **Entitlements never resolve below the free baseline.** A failed payment
  degrades a customer to free — never to less than free, and never by
  deleting anything.

`apps/api/src/entitlements.ts` caches a resolved subscription per identity
for 30 seconds. The replica that applies a change invalidates its own entry
immediately; the TTL bounds how stale another replica can be. If the read
fails, resolution falls back to the free baseline and logs — entitlement
resolution must never take the product down.

---

## 5. Enforcement points

Every limit that was a direct `AppConfig` read is now an entitlement lookup:

| Surface | Entitlement | Was |
|---|---|---|
| `POST /v1/analyses` | `analysis.daily` | `FREE_USER_DAILY_LIMIT` |
| `POST /v1/comparisons` | `compare.daily` | `COMPARE_DAILY_USER_LIMIT` |
| `POST /v1/wallets/:address/ask` | `ask.daily` | `ASK_AEGIX_DAILY_QUOTA` |
| `GET /v1/markets*` | `markets.daily` | `MARKETS_DAILY_QUOTA` |
| `POST /v1/monitors` | `monitors.active` | `MAX_ACTIVE_MONITORS_PER_USER` |
| `POST /v1/developer/keys`, rotate | `apiKeys.active` | `MAX_ACTIVE_API_KEYS_PER_USER` |
| developer API quota claim | `api.daily` | `DEVELOPER_DAILY_QUOTA` |
| `POST /v1/webhooks` | `webhooks.active` | *(unbounded)* |

Anonymous visitors keep their config limits: a plan needs an identity, so
`FREE_ANON_DAILY_LIMIT` and `COMPARE_DAILY_ANON_LIMIT` are unchanged.

The webhook row is the one behaviour change for an existing identity: active
webhook endpoints per user were previously unbounded, and are now capped at
`MAX_ACTIVE_WEBHOOKS_PER_USER` (default 5) on the free plan. An identity
already over the cap keeps every endpoint it has; only creating another is
refused, with `WEBHOOK_LIMIT_REACHED`.

---

## 6. Payment provider seam

`architecture.md` PR-12 keeps payment infrastructure out of this baseline.
D11 therefore ships everything that is useful whether or not money is being
collected — the catalog, entitlements, the ledger, metering, invoices —
behind an interface a processor can implement later without touching routes,
repositories or the state machine.

The shipped provider is `manual`: `supportsSelfServe === false`. The rule the
API enforces is:

> Starting or changing a paid subscription requires a payment provider.
> Ending one never does.

So `POST /v1/billing/subscription/change` answers `501
PAYMENT_PROVIDER_REQUIRED`, while cancel and resume always work. Creating a
paid subscription nobody paid for would put a falsehood in the ledger.

Paid plans are granted by an operator, and — because the `manual` provider has
no processor to collect the next period — renewed only when the operator
confirms the invoice payment:

```bash
pnpm billing:grant -- --user <uuid> --plan pro
pnpm billing:grant -- --user <uuid> --action CANCEL
pnpm billing:grant -- --user <uuid> --show
pnpm billing:grant -- --invoice <id> --mark-paid
```

The grant and the settlement are not database pokes. Both go through the same
state machine and write the same `billing_events` entry (tagged `grantedBy:
operator`, and `invoiceId` for a settlement) as any other transition, so the
ledger stays a complete history of how every subscription reached its current
state. `--mark-paid` is idempotent: the invoice id is the ledger's event key,
so a replayed command settles once and extends exactly one period.

---

## 7. Lifecycle state machine

```text
(none) --SUBSCRIBE--> TRIALING --RENEW--> ACTIVE
                          |                 |
                   PAYMENT_FAILED    PAYMENT_FAILED
                          v                 v
                       PAST_DUE --PAYMENT_RECOVERED--> ACTIVE
                          |
                    (grace ends)
                          v
                       EXPIRED

ACTIVE --CANCEL--> CANCELED --RENEW/EXPIRE--> EXPIRED
                       |
                   --RESUME--> ACTIVE
```

Notable rules:

- **`RENEW` on a subscription already scheduled for cancellation ends it.**
  One call covers both outcomes, so the periodic job cannot branch wrongly —
  or forget to branch.
- **Repeated payment failures never extend the grace window.** It is anchored
  to the first failure, so a retry storm cannot buy free paid service.
- **A plan change preserves the billing period.** Restarting the period would
  re-charge the customer for days already paid for.
- **The free plan is the absence of a subscription, not a subscription.**
  `SUBSCRIBE`/`CHANGE_PLAN` to `free` is rejected; moving to free is a
  cancellation.
- **`EXPIRED` is terminal.** A new paid period requires a fresh `SUBSCRIBE`.

Each call returns the next state *and* exactly one event. The caller
persists both in one transaction.

---

## 8. Schema (migrations 0010, 0011)

```text
plans               catalog snapshot; seeded by the migration, upserted by the
                    API on first billing request
subscriptions       one row per identity (unique user_id); current state only
billing_events      append-only ledger, unique on event_key
invoices            one per identity per period (unique user_id, period_start);
                    OPEN → PAID via markInvoicePaid, paid_at records settlement
usage_records       unchanged from 0001; gains (user_id, usage_type, created_at)
privacy_monitors    gains status_reason (0011), so a plan-limit pause
                    (ENTITLEMENT_PAUSED) is distinguishable from a pause the
                    user chose and can be reversed without touching either
```

`billing_events.event_key` is the idempotency anchor, the same pattern
`developer_usage_events.request_id` uses (D6-D §75). `applyTransition` claims
the ledger row **first**: if the key already exists the transition is a
replay and nothing is mutated. Claiming after the state write would let a
retried `RENEW` advance the billing period twice.

`profiles.plan` predates D11 and is still read as a coarse label. It is
updated inside the same transaction as the subscription, so it cannot drift
from what it describes: the subscribed plan while live, `free` once expired.

RLS is enabled on `subscriptions`, `billing_events` and `invoices` with
select-own policies (§71). Writes are deliberately not granted to clients:
billing state changes only through the API, which owns the state machine.
`plans` carries no RLS — it is public reference data with no user column.

---

## 9. Metering and invoices

Metering counts nothing new. It maps the counters that already exist:

| Dimension | Source |
|---|---|
| `WALLET_ANALYSIS` | `usage_records.usage_type = expensive_analysis` |
| `COMPARISON` | `usage_records.usage_type = comparison` |
| `WALLET_CONTEXT` | `usage_records.usage_type = wallet_context` |
| `ASK_AEGIX` | `usage_records.usage_type in (ask_aegix, ask_markets)` |
| `MARKETS` | `usage_records.usage_type = markets` |
| `API_CALLS` | `developer_usage_events` where `status = SUCCESS` |
| `MONITORED_WALLETS` | active monitor count — a level, not an accumulation |

`cache_hit` is deliberately unmapped: a cached result does no new work and
consumes no quota (D3-C §24), so it must never reach an invoice.
`WALLET_CONTEXT` is metered but has no entitlement — it is a read over
already-persisted results, bounded by a per-minute rate limit (D8 §10).

An invoice is derived, never accumulated: given a plan, a period and the
metered usage, `computeInvoice` produces the same lines every time. Re-running
it updates the same row rather than raising a second bill, and a
disagreement between two runs is a bug rather than a judgement call. Amounts
are integer cents throughout; no float touches a chargeable amount.

Under the v1 catalog an invoice is exactly one subscription line. Invoices
with a balance are raised `OPEN`. With the `manual` provider an invoice is
settled by an operator confirming payment (`--mark-paid`), which records
`paid_at` and extends the subscription exactly one billing period through the
same state machine; a replayed settlement is absorbed by the ledger's event
key. Invoices are raised for a closed period whether it renewed or ended
unpaid, so a lapsed period is still collectible.

A plan limit is not a data-retention policy: when an identity drops to free,
its monitors beyond the free level are **paused** (`status_reason =
ENTITLEMENT_PAUSED`) and restored when a paid period returns — never deleted.
A monitor the user paused themselves is left untouched.

---

## 10. Lifecycle sweep

`runBillingLifecycle` runs on a 5-minute interval in the worker, guarded by
`ENABLE_BILLING`. Subscriptions age on wall-clock boundaries, not on
requests.

Time is not payment. A **manually provisioned** subscription whose period
elapses ends unpaid (`EXPIRE`, reason `PERIOD_ELAPSED_UNPAID`) — the sweep
never advances a manual period on wall-clock alone — and the closed period is
invoiced `OPEN` so an operator can collect it. A **processor-managed** row
(`provider <> 'manual'`) still renews on the provider's schedule; removing the
manual path leaves that untouched. A scheduled cancellation ends through
`RENEW` for every provider.

After an applied transition the sweep reconciles the identity's monitors with
its resolved entitlement: uncovered monitors are paused, and monitors paused
by an earlier lapse are restored. This is idempotent, so running it on every
transition is safe.

It is safe to run concurrently on several replicas: every transition carries
a deterministic event key derived from the boundary being crossed
(`<userId>:<reason>:<boundary>`), so a second replica computes the same
transition, hits the unique index and changes nothing. A failing subscription
is logged and skipped; the rest are independent, and the next tick retries
with the same key.

A sweep failure never fails the worker heartbeat. Billing being late is not
the product being down.

---

## 11. HTTP surface

```text
GET    /v1/billing/plans                   public catalog, no auth
GET    /v1/billing/subscription            plan, status, entitlements, period
GET    /v1/billing/usage                   metered usage vs entitlements
GET    /v1/billing/invoices                recent invoices
GET    /v1/billing/invoices/:id            one invoice
GET    /v1/billing/events                  the identity's own ledger
POST   /v1/billing/subscription/change     501 while no provider exists
POST   /v1/billing/subscription/cancel     schedules, or `{immediate: true}`
POST   /v1/billing/subscription/resume     revokes a scheduled cancellation
```

Error codes: `FEATURE_DISABLED` (403), `UNAUTHENTICATED` (401),
`UNKNOWN_PLAN` (400), `RETIRED_PLAN` (409), `INVALID_TRANSITION` (409),
`PAYMENT_PROVIDER_REQUIRED` (501), `NOT_FOUND` (404).

`ENABLE_BILLING=false` returns 403 from every billing route and
short-circuits entitlement resolution to the baseline without touching the
database — the product runs exactly as it did before D11.

---

## 12. Configuration

```text
ENABLE_BILLING=true            kill switch; false = pre-D11 behaviour
BILLING_PROVIDER=manual        the only implementation in this baseline
BILLING_CURRENCY=USD
BILLING_TRIAL_DAYS=0           trials are off; a trial cannot convert
                               without a way to charge for what follows
BILLING_GRACE_DAYS=7           PAST_DUE keeps paid limits this long
BILLING_HISTORY_LIMIT=50       page size cap for ledger/invoice listings
MAX_ACTIVE_WEBHOOKS_PER_USER=5 new: the free-plan webhook level
```

Every other number the catalog uses is an existing knob. Tuning limits by
cost (§82) stays a one-knob operation.

---

## 13. Tests

```text
packages/billing        76 unit tests — catalog, entitlements, lifecycle,
                        metering, rollup, invoice, apply, settlement
apps/api                12 tests — baseline equivalence, caching, degraded
                        resolution, store adapter, route surface
tests/e2e-d11.ts        entitlement enforcement against a live 429, operator
                        grant, ledger ordering, cancel/resume, manual period
                        ending unpaid (no renewal) with its invoice, grace
                        degradation
tests/e2e-d11-revenue-  the revenue-safety flow through the real CLI:
safety.ts               grant → unpaid period expires → free → uncovered
                        monitors paused (data retained) → --mark-paid → PAID,
                        one period extension, entitlements and monitors
                        restored → duplicate mark-paid is a no-op → invalid
                        invoices refused → processor-managed row still renews
tests/migration-test.ts 0010 seeds 3 plans, creates no subscription for an
                        existing user, leaves profiles.plan on free; 0011 adds
                        the monitor entitlement-pause reason
tests/web-restored-smoke.ts  /app/billing renders in the production build
```

The e2e sets `MARKETS_DAILY_QUOTA=2` so the difference between a free
identity and a granted one shows up as a real `429`, not as a number in a
response body.

---

## 14. Operational notes

- **Rollout is inert.** Applying 0010 and deploying with `ENABLE_BILLING=true`
  changes no limit for anyone, because nobody has a subscription row.
- **Rollback.** Set `ENABLE_BILLING=false`; enforcement returns to the config
  values immediately, and the tables are simply unread. The migration does
  not need reverting.
- **Granting a plan out of band** (the script, or another API replica) is
  visible to a given replica within the 30-second resolution TTL.
- **A catalog change** (tuning a config limit) takes effect on restart for
  enforcement, and reaches the `plans` snapshot on the first billing request
  after that.
