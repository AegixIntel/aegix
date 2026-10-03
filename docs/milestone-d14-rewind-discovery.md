# Milestone D14 — AEGIX Rewind and the AEGIX Discovery Engine

Written for: engineers working on this repository, and operators deciding when
to switch either feature on.

D14 adds an append-only observation ledger and two products that read it:

- **AEGIX Rewind** — pick a subject and a moment, and see what AEGIX had
  already stored before that moment. "Could AEGIX have seen it?"
- **AEGIX Discovery Engine** — a scheduled scan that looks for relationships
  between series nobody asked about, and stamps each one with a Discovery ID.

The safety property:

> **`ENABLE_REWIND_CAPTURE`, `ENABLE_REWIND` and `ENABLE_DISCOVERY` all default
> to `false`. Migration 0015 only creates new tables. Nothing here changes an
> existing deployment until an operator opts in.**

No existing engine, score, API contract or table is changed.

---

## 1. What is and is not built

Built:

```text
observation ledger     observation_points: (series, event time, value, source),
                       bitemporal, append-only, first observation wins
signal captures        signal_captures + signal_snapshots: what the market
                       signal engine reported at capture time, with its version
capture sweep          worker interval, one capture per asset per time bucket
Rewind                 POST /v1/rewind, /app/rewind — replay of stored captures
                       for BTC, ETH, SOL and for completed wallet analyses
series sources         tokenized stocks over Solana RPC, GDELT news volume,
                       Cboe delayed options — each behind its own flag (§4a)
Discovery Engine       daily scan over every series being captured,
                       FDR-controlled, with a baseline novelty test and
                       out-of-sample confirmation
Discovery ID           AEX-<n>, database-stamped time, hash-chained
read API and UI        GET /v1/discoveries, GET /v1/discoveries/:id,
                       /app/discoveries
```

Not built, and not claimed:

```text
exchange equity prices      not read; tokenized stocks are the token's on-chain
                            price, which is a different thing (§4a)
sector rotation             no sector ETFs exist among the verified tokens
commodities                 tokenized gold only; no copper, no uranium
social / sentiment          narrative is news volume only
daily-resolution scan       options series are captured but mostly untestable
                            by the hourly engine (§4a)
backfilled captures         deliberately impossible — see §2. The Discovery
                            Engine's price history is a different matter (§4b)
external timestamp anchor   the hash chain is internal to the database (§5)
```

The product concept describes a relationship between on-chain AI-infrastructure
activity, power-sector options, copper and narrative velocity. Of those, what
the engine can actually read today is: NVDAx and other tokenized equities
on-chain, options activity for XLU and five other underlyings, and news volume
for "data center", "AI infrastructure", "power grid", "copper" and "uranium".
Copper and uranium exist only as news topics, not as prices. Adding a series
is adding a source and a descriptor; the statistics do not change. Capture
started in production on 1 October 2026, and both products are LIVE from that
date with the limits §2 and §4b describe.

## 2. The no-hindsight rule

A replay that recomputes old data with current code is lookahead bias: the
parser, the thresholds and the entity registry all know things they did not
know then. D14 never does this.

```text
at capture time    the engine runs once, its output and engine version are
                   stored, and the row can never be changed
at replay time     stored rows are read; no provider, RPC or engine is called
```

Consequences that follow, and are disclosed rather than hidden:

- **Rewind reaches back only to the first stored capture.** There is no
  backfill. A window with no capture returns `NO_COVERAGE` — "absence of
  record, not absence of signal".
- **`observed_at` is the database clock.** A trigger overwrites whatever the
  writer supplies, so a row cannot be backdated.
- **The first observation wins.** If a provider later revises an hourly value,
  the ledger keeps what was known first.
- **The lock is applied twice**: in the SQL (`observed_at < eventTime`) and
  again in `buildReplay`, which counts anything it had to refuse.

Wallet replays read `analysis_jobs` and `exposure_signals`, which are
insert-only in the application but are **not** trigger-protected and still
cascade on wallet deletion. A wallet replay says so in its limitations, and its
coverage is irregular: an analysis exists only when someone asked for one.

## 3. Rewind

`POST /v1/rewind` with `{ subjectType, subject, eventTime, lookbackHours }`.
Authenticated, rate-limited, `ENABLE_REWIND`.

```text
verdict
  NO_COVERAGE            no capture stored in the window
  NOTHING_OBSERVED       captures exist, no signal met its threshold
  SIGNALS_OBSERVED       at least one signal, no convergence
  CONVERGENCE_OBSERVED   one capture held >= 3 distinct signal types
```

Checkpoints sit at fixed fractions of the lookback (72h gives T−72, −48, −24,
−8, −2) and show the distinct signal types stored by then. Convergence is the
earliest single capture with three or more distinct signal types; its lead time
is `eventTime − observed_at`.

Rewind audits observability. It does not claim the event was predictable, and
the response says so.

## 4. Discovery Engine

Scanning many pairs is how spurious relationships are manufactured, so the
controls are the engine:

```text
preregistration    series, transform, lags and windows are fixed by
                   DISCOVERY_ENGINE_VERSION; not configurable by environment
stationarity       series are differenced to hourly log-changes; gaps are
                   skipped, never interpolated
autocorrelation    p-values use Bartlett's effective sample size
multiplicity       Benjamini–Yekutieli q-values over every hypothesis the run
                   tested; the run stores that count
novelty            a pair already correlated (|r| >= 0.3 at any lag) in the
                   disjoint baseline window is not a discovery
confirmation       a discovery is a CANDIDATE until a later window that does
                   not overlap the detection window reproduces it at the same
                   lag and sign
```

Parameters (v1.0.0): 168h test window, 168h baseline, 13 lags from −24h to
+24h, at least 96 paired observations, FDR level 0.05. One run per UTC day.
The run scans the series whose capture is switched on, so the hypothesis count
depends on the flags: 6 market series give 195 hypotheses; all 54 series give
18,603. Benjamini–Yekutieli gets stricter as that count grows, which is the
price of looking in more places, and the count is stored with every run.

The card's "confidence" is `1 − q`. It is not the heuristic confidence used by
the wallet correlation engine, and it is not a probability that the
relationship is causal.

**What the FDR claim covers.** The rate is controlled within one run. Runs
repeat daily over overlapping windows, so over many runs a CANDIDATE is more
likely to appear by chance than within a single run. Confirmation in a disjoint
window is the answer to that, which is why CANDIDATE and CONFIRMED are separate
states and the UI shows which one a discovery is in.

Every hypothesis a run considered is stored in `discovery_tests`, including
those that were ineligible and those that found nothing. A q-value with no
record of what else was tested is not evidence.

A discovery is a statistical relationship between two series. It is not
causation, and it identifies no participant, owner or intent.

## 4a. Series sources

Each source is a separate opt-in, and each reads only what it can identify.

```text
flag                             source                      series
ENABLE_REWIND_CAPTURE            CoinPaprika                 BTC, ETH, SOL price and rolling 24h volume
ENABLE_TOKENIZED_STOCK_CAPTURE   Solana RPC (RPC_URL)        14 tokens: on-chain price (USDC) and supply
ENABLE_NARRATIVE_CAPTURE         GDELT DOC 2.0               8 topics: share of global news volume, hourly
ENABLE_OPTIONS_CAPTURE           Cboe delayed quotes         6 underlyings: put/call ratio, open interest,
                                                             and call/put volume (stored, not scanned)
```

**Tokenized stocks.** Fourteen xStocks (TSLAx, NVDAx, SPYx, AAPLx, QQQx,
GOOGLx, MSTRx, COINx, CRCLx, HOODx, METAx, AMZNx, MSFTx, GLDx). Two
`getMultipleAccounts` calls per sweep read every mint and every pool.

- The registry was verified on mainnet on 2026-10-01: each mint is a Token-2022
  mint whose own metadata carries the symbol, all share one mint authority, and
  each pool is a Raydium CLMM account naming that mint and USDC. Decoded prices
  matched an independent reference within about 1%.
- The check is repeated on every read. A mint with a different owner, decimals
  or authority, or a pool that is not that exact pair, yields no value. It is
  never decoded on the assumption that it is still the right account.
- `pnpm verify:tokenized-stocks` re-verifies the registry against a live RPC.
- **The price is the token's price in one pool.** It follows the underlying
  equity only as far as arbitrage holds it there, it trades when the stock
  market is closed, and a single large swap moves it. Nothing in the product
  calls it the stock's price.
- Supply is the tokens outstanding. It changes on issuer mint and redeem, and
  is flat most hours; a flat window is recorded as `NO_VARIANCE`, not tested.
- Tokenized stocks also get signal captures, so Rewind can replay them. Only
  price is read, so the volume signal can never fire for them.

**Narrative.** GDELT's "volume intensity" for a fixed list of eight topics,
averaged to completed hours. GDELT documents one request every five seconds,
but that is not what decides whether a request is answered: measured on
2 October 2026 from the production host and from an unrelated network, it
answered HTTP 429 to about four requests in five, whether they were twenty
seconds or an hour apart. So a sweep asks for one topic, in rotation, every ten
minutes, and asks up to seven times, forty seconds apart, until it is answered.
At one answer in five that gets a topic through about four turns in five. Each
topic has a turn every eighty minutes and each answer covers three days. A
topic still refused after seven attempts is logged
(`narrative topic not captured`) and left for its next turn. GDELT's data
trails real time by about five hours. It measures how much is published, not sentiment and not social media.
The topic list is part of the hypothesis set: a topic is not added because a
story is already trending.

**Options.** The whole chain per underlying (SPY, QQQ, XLU, XLE, NVDA, TSLA)
from Cboe's delayed quotes, summed to put/call volume ratio and open interest.
Two things to know before enabling it. First, this is the exchange's public
website feed, delayed, with no redistribution licence; it is off by default
for that reason and should be replaced by a licensed feed before it backs a
public claim. Second, options trade about 6.5 hours a day and the engine needs
consecutive hours, so these series will mostly be recorded as
`INSUFFICIENT_DATA` until a daily-resolution scan exists. They are captured
now because a ledger cannot be backfilled later.

Observations from these sources are stamped with the minute they were read. A
source that fails adds nothing, and the ledger shows the gap.

## 4b. Provider history read back for the Discovery Engine

The engine tests nothing until the ledger holds 14 days of hourly
observations. Rather than wait for them, production read those days from
providers that publish history, once, on 1 October 2026.

```text
series                              provider       source column
BTC, ETH, SOL price, 24h volume     CoinGecko      coingecko
14 tokenized stocks, pool price     GeckoTerminal  geckoterminal:raydium-clmm
8 narrative topics, news volume     GDELT          gdelt-doc-v2, from 20 September
supply, options                     none           not written
```

`scripts/backfill-discovery-history.ts` writes the rows to a CSV and
`scripts/backfill-discovery-history.sql` loads it. What holds:

- **Rewind is not touched.** A replay reads signal captures, and none is
  written. Every backfilled tokenized stock hour is older than the 25 hours of
  ledger a capture reads, so no stored signal was computed from one.
- **No hourly change spans two providers.** Each series stops at least a whole
  hour before its first live observation, and the load refuses to run
  otherwise. This matters: on the hours both held, prices agreed within about
  1%, but CoinGecko's rolling 24h volume sat 26–36% away from CoinPaprika's.
  Within one provider that is a constant offset and vanishes in a log-change;
  across the seam it would have been one large, simultaneous move in three
  series.
- **A backfilled row is recognisable.** `observed_at` is stamped at load time,
  days after `event_time`, and the source column names the provider.
- **GeckoTerminal's hourly close stands in for the pool price** at the end of
  that hour. It is the last trade in the same Raydium CLMM pool, and the script
  skips a pool whose two mints are not the registry's stock and USDC.

What it costs: the scan's "first measurable in this window" statements now
rest partly on data AEGIX did not observe as it happened. A discovery whose
window starts before 1 October 2026 was found in provider history, and the
confirmation window is what tests it on observations AEGIX made itself.

GDELT capture was switched off in production from 1 October 2026 21:15 UTC
while its refusals were measured, and the scan of 2 October ran without the
narrative series.

**Narrative history** comes from GDELT itself, through
`scripts/backfill-narrative-history.ts`: the same endpoint and measure the
live source reads, asked for explicit windows instead of the last three days,
so its rows carry the live source's name and there is no seam between
providers. A window must stay under 72 hours to be answered at 15-minute
resolution; a 14-day window comes back daily. What GDELT holds limits it, and
was measured on 2 October 2026:

```text
before 20 September 2026         nothing; GDELT answers an empty object
25 September 09:00 – 27 September 00:00   no data for any topic
other days                        21–24 of 24 hours, the same hours for every topic
```

The history was loaded into production on 3 October 2026 at 18:40 UTC: 1,928
rows read, 241 for each of the eight topics, from 20 September 00:00 to
2 October 08:00. 1,427 were new; the other 501 were hours the live source had
already captured, which keep their first observation. On those the two
readings differ by 0.0008 on average, against a mean value of 0.30.

That was after the scan of 3 October. It ran with the narrative series but
only their live hours from 29 September, and recorded all 3,900 narrative
pairs as `INSUFFICIENT_BASELINE`, none tested. The scan of 4 October is the
first to read the history.

The narrative baseline is still thinner than the market one. Counted on the
history before it was loaded, six topics have enough paired hours at short
lags and none at ±24h; `power-grid` falls one hour short of the 96-pair
minimum and `stablecoin`, with many zero hours, far short. Each of those is
recorded as `INSUFFICIENT_BASELINE` or `INSUFFICIENT_DATA`, not tested. The
gap closes as the windows move past 27 September, around the epoch of
11 October.

GDELT itself has published nothing after 2 October 08:00 UTC, as read on
3 October at 17:10 UTC: a request for the last three days ends at that hour.
Capture is on and its sweeps add nothing until GDELT resumes, and each scan
until then has that many fewer narrative hours in its window.

## 5. Discovery ID

```text
Discovery #AEX-<id>
First detected: <detected_at>
```

- `detected_at`, `prev_chain_hash` and `chain_hash` are written by a trigger.
  The application cannot choose them.
- `chain_hash = sha256(prev_chain_hash | fingerprint | detected_at)`, so
  removing or reordering a discovery breaks every later hash.
- `fingerprint = sha256(engine version | pair | lag | window)`.
- `UPDATE` and `DELETE` are rejected on the row. Status changes are new rows in
  `discovery_events`.

Limit: the chain is tamper-evident against edits made through SQL by a role
that cannot drop triggers. A database superuser can still rewrite it. Proving a
timestamp to a third party needs the chain head published somewhere AEGIX does
not control; that is not built.

## 6. Operating it

```sh
ENABLE_REWIND_CAPTURE=true     # worker: start the ledger
ENABLE_REWIND=true             # API: expose replays
ENABLE_DISCOVERY=true          # worker scan + API
REWIND_CAPTURE_INTERVAL_SECONDS=900
ENABLE_TOKENIZED_STOCK_CAPTURE=true   # worker: Solana RPC, 2 calls per sweep
ENABLE_NARRATIVE_CAPTURE=true         # worker: GDELT, hourly
ENABLE_OPTIONS_CAPTURE=true           # worker: Cboe delayed, hourly, unlicensed
```

Order matters. Turn capture on first and leave it running: Rewind has nothing
to replay before the first capture, and the Discovery Engine records
`INSUFFICIENT_BASELINE` for every hypothesis until the ledger holds 14 days of
hourly observations. Capture calls the market provider once per asset per
interval, in addition to user traffic.

Both sweeps are safe on several worker replicas: a capture is unique per
(subject, bucket, engine version), a ledger point per (series, event time,
source), and a run per (engine version, epoch).

Restore a backup as a full dump, as the runbook's restore drill does: `pg_dump`
recreates triggers after loading data, so stored timestamps and chain hashes
survive. A data-only load into an existing schema would fire the stamping
triggers and rewrite `observed_at` and `detected_at` to the restore time; do
not do that without `--disable-triggers`.

The D14 tables cannot be pruned. With only the market capture on they grow by
roughly 290 captures and 150 ledger points per day. With every source on that
becomes about 1,600 captures, 3,600 ledger points and 18,600 `discovery_tests`
rows per day; the last is the largest, around 7 million rows a year.

Turning a source on changes the set of hypotheses from the next run onward.
Each run records its series count and hypothesis count, so runs before and
after remain interpretable, but they are not directly comparable.

## 7. Verification

```text
packages/rewind      unit: lock, checkpoints, convergence, coverage verdicts
packages/discovery   unit: BY q-values, effective sample size, no discovery on
                     independent series, planted relationship found at its lag,
                     known relationship rejected, no read past the epoch,
                     confirmation flow
packages/sources     unit: pool price decode in both token orders, identity
                     checks that refuse a wrong account, GDELT hourly
                     aggregation and request spacing, options chain
                     attribution
tests/e2e-d14.ts     PostgreSQL: append-only triggers, backdating refused,
                     capture idempotency, Rewind lock through the API,
                     tokenized stock capture and replay, Discovery ID chain,
                     read API, feature gates
```

`pnpm test:e2e-d14` is part of `pnpm release:gate` and CI.
