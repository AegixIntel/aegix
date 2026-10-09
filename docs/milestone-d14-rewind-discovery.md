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
                       Cboe delayed options, Cboe delayed sector and
                       commodity fund prices — each behind its own flag (§4a)
Discovery Engine       a scan each day over every series being captured,
                       FDR-controlled, with a baseline novelty test and
                       out-of-sample confirmation; at hourly resolution, and
                       at daily resolution behind its own flag (§4)
Discovery ID           AEX-<n>, database-stamped time, hash-chained
chain anchors          the chain head sent to public OpenTimestamps calendars,
                       behind its own flag; the chain and its proof files are
                       readable without a session (§5)
read API and UI        GET /v1/discoveries, GET /v1/discoveries/:id,
                       /app/discoveries, with the signal graph drawn
```

Not built, and not claimed:

```text
exchange equity prices      not read; tokenized stocks are the token's on-chain
                            price, which is a different thing (§4a)
sector rotation             eleven sector funds can be captured (§4a) and scanned
                            daily; no rotation signal is derived from them
commodities                 tokenized gold on-chain. Copper, uranium, gold and
                            oil only as funds (CPER, URA, GLD, USO), which are
                            not spot prices (§4a)
social / sentiment          narrative is news volume only
a tested daily scan         the daily scan is built (§4) and has tested nothing:
                            it needs about four months of daily observations
backfilled captures         deliberately impossible — see §2. The Discovery
                            Engine's price history is a different matter (§4b)
anchor upgrade              receipts are stored as the calendar returned them,
                            pending; the standard client upgrades them (§5)
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

The page plays the checkpoints in order, oldest first, and names the
convergence once the last one is shown. It is the same stored record either
way; with reduced motion set in the browser nothing is animated.

**Discoveries already on record.** For an asset, the replay also lists the
Discovery IDs on that asset's own series (`market:<asset>:*`, or
`xstock:<symbol>:*`) whose `detected_at` is before the event time. This is a
read under the same lock, applied in the SQL and again in `buildReplay`:

```text
which       detected_at < eventTime, not limited to the lookback window: a
            relationship found earlier was still on record
status      the latest discovery_events row stored before eventTime, so a
            confirmation that came after the event is not shown
verdict     unchanged. A discovery is a relationship between two series, not
            a signal about the event, and the response says so
needs       ENABLE_DISCOVERY; a wallet has no series and lists none
```

`/app/rewind?subject=<asset or wallet>&eventTime=<ISO>&lookback=<hours>` fills
the form in and does not press the button. A discovery's detail links there
for each of its series that can be replayed, with the discovery's own stamp as
the event time.

Rewind audits observability. It does not claim the event was predictable, and
the response says so.

## 3a. Context signals: news topics and funds

Narrative and sector series were in the ledger with no signal engine run at
capture time, so a replay could not show them: deriving a signal from them
at replay time would be hindsight. `ENABLE_CONTEXT_SIGNAL_CAPTURE` runs an
engine at capture time instead, after each source's sweep, and stores the
result as signal captures. Migration 0017 lets a capture belong to the
domains `NARRATIVE` and `SECTOR` besides `MARKET`; nothing else changes.

It reaches back only to the first such capture, like every other replay.
The thresholds are fixed by `context-v1.0.0` and are not configurable:

```text
NARRATIVE_ACCELERATION     a topic's GDELT Context article count: the mean of
                           the newest 6 settled hours is at least 2 times the
                           mean of the 48 hours before, and at least 3 an
                           hour. Needs 4 of the 6 and 24 of the 48 hours on
                           record; with fewer the capture is stored with no
                           signal and LOW quality
SECTOR_RELATIVE_STRENGTH   a sector fund's move on the day is 1.5 points or
SECTOR_RELATIVE_WEAKNESS   more from the median of the sector funds; needs
                           8 of the 11 with a return
FUND_DAILY_MOVE            any of the 16 funds is 2.5% or more from the
                           previous session's last read price
```

- A topic is captured when its turn in the source's rotation ends, at most
  once an hour; in practice about every eighty minutes.
- A fund is captured once an hour while the US session is open, and only if
  it has a price today. Its day is today's last read price over the last
  read price of the previous session, at most five days back.
- An hour with no article and an hour that was not read are both absent from
  the ledger. Both are left out of the averages, never counted as zero.
- The topic list and the fund list are the Discovery Engine's, and the same
  rule holds: neither is extended because something is already in the news.

In Rewind:

```text
subjects   subjectType "narrative" with a topic id, "sector" with a fund
           symbol; GET /v1/rewind/subjects lists them as topics and funds.
           A topic has one signal type and a fund at most two, so neither
           can reach a convergence; the response says so
context    a replay of an asset also returns `context`: one entry per
           signal type per topic or fund, from the captures that held a
           signal in the window, under the same lock. It is the
           surroundings of the asset. Nothing links it to the asset and it
           does not enter the verdict
```

No rotation signal across sectors as a whole is derived, and nothing here
is sentiment or social media.

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

**The daily scan** (`ENABLE_DISCOVERY_DAILY`, engine `discovery-daily-v1.0.0`)
is a second preregistered hypothesis set over the same series, for the ones
that only move in market sessions. The controls are the same; the resolution
is not:

```text
step        one UTC day: the day's last observation, differenced against the
            day before. A day with no observation is a gap, so a session
            series has no change across a weekend or a holiday
windows     60 days tested, 60 days of baseline before them
lags        0, ±1, ±2, ±3 and ±5 days (9)
minimum     30 paired daily changes; a session series has about 34 in 60 days
```

It runs once per UTC day beside the hourly scan, as its own run with its own
hypothesis count, and its discoveries join the same Discovery ID chain. A lag
is stored in hours in both, so a daily lag of two days is `48`. Nothing can
be tested until a series has about four months of daily observations: capture
began on 1 October 2026 for market and tokenized stock series, and begins for
options and funds on 6 October 2026, when their flags were set. Until then every
hypothesis is recorded as `INSUFFICIENT_BASELINE`. The scan loads 125 days of
ledger for every series in one read.

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
ENABLE_NARRATIVE_CONTEXT_CAPTURE GDELT Context 2.0           the same 8 topics: articles mentioning it, per hour
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

**Narrative, second reading.** GDELT's DOC 2.0 index stopped taking articles
on 2 October 2026 (§4b) while its Context 2.0 index stayed current, so the
same eight topics are also read from there, under their own source name
(`gdelt-context-v2`) and their own series (`narrative:<topic>:context_mentions`).
Neither reading stands in for the other and no series holds rows from both.

- **It is a count, not a share**: the distinct articles GDELT saw in one hour
  with a sentence matching the topic's query. The Context API has no timeline
  mode and searches a subset of what DOC 2.0 does. Measured on 4 October 2026
  the counts were 1 to 32 an hour, and `stablecoin` 0 to 2.
- **Each hour is asked for on its own.** A 24-hour window was answered with 50
  articles reaching back 12 hours, cut off at a depth the API does not report;
  four one-hour windows returned the same counts both times they were asked.
- **A turn asks for three hours.** One topic per sweep, in the same rotation as
  the first reading; the three hours that have been over for at least an
  hour, six seconds apart. Every hour is asked for in two turns, so one missed
  turn loses nothing. 24 of 24 requests were answered when measured.
- **Connecting is given the whole 45 seconds.** GDELT's TLS handshake took
  just over ten seconds from the production host, and Node's fetch stops
  connecting at ten: 4 of 24 requests failed that way and were reported as
  `PROVIDER_ERROR`. Both GDELT sources now connect through an agent with a
  45-second connect timeout, and the same run answered 24 of 24.
- **A zero hour is not written.** The engine takes no change from one, and an
  index that has stopped answers zero as well.
- **A full page of 200 is not written**: the count was cut off.
- **The API keeps 72 hours.** There is no history to read back, so these
  series have no baseline until the ledger has held them for 14 days, and an
  hour not read within 72 hours is gone.
- If the index stops partway through an hour, that hour is stored low. The
  hour's delay before asking covers the usual fifteen minutes, not a stall.

**Options.** The whole chain per underlying (SPY, QQQ, XLU, XLE, NVDA, TSLA)
from Cboe's delayed quotes, summed to put/call volume ratio and open interest.
Two things to know before enabling it. First, this is the exchange's public
website feed, delayed, with no redistribution licence; it is off by default
for that reason and should be replaced by a licensed feed before it backs a
public claim. Second, options trade about 6.5 hours a day and the hourly scan
needs consecutive hours, so it records these series as `INSUFFICIENT_DATA`;
the daily scan (§4) is what reads them.

**Sector and commodity funds.** The last traded price of sixteen
exchange-traded funds, from the same Cboe feed and with the same standing:
delayed, no redistribution licence, off by default.

```text
sectors       XLK XLF XLE XLU XLV XLI XLY XLP XLB XLRE XLC
industry      SMH (semiconductor companies)
commodities   CPER (copper futures), URA (uranium miners),
              GLD (gold bullion), USO (oil futures)
```

- **A fund's price is not the commodity's price.** CPER and USO hold futures
  and lose to the roll; URA is shares of miners, not uranium. Each series'
  label names the fund and what it holds, and nothing calls it a spot price.
- **A quote is kept only if it names the fund and traded today** in New York.
  On an exchange holiday the feed answers with the day before, and that is
  not written.
- The list is part of the hypothesis set, like the narrative topics: a fund is
  not added because its sector is already in the news.

**Session sources ask only while the US market is open** — weekdays from 09:30
to 17:00 New York time, which includes one read after the close. The feed
keeps answering on a Saturday with Friday's values, and a source that stored
them would write days on which nothing moved. A weekend is a gap in the
ledger instead. This applies to options and to the funds. Options cannot tell
a holiday from their own data, so a weekday holiday is still read and stores
the totals of the day before.

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

The narrative baseline is still thinner than the market one, and the scan of
4 October shows by how much. It tested 681 narrative pairs, at every lag from
−24h to +24h, and rejected none. Five topics had pairs tested and three had
none, counted in usable hourly changes against the 96-pair minimum:

```text
topic               window   baseline   tested
copper                 111        110   yes
semiconductor          111        110   yes
data-center            110        109   yes
ai-infrastructure      100        105   yes
uranium                 99         98   yes
bitcoin                 94        100   no, INSUFFICIENT_DATA: two short in the window
power-grid              87         95   no, INSUFFICIENT_BASELINE: one short
stablecoin              40         59   no, INSUFFICIENT_BASELINE
```

An hour whose share is zero has no log-change and takes the next hour's with
it. `bitcoin` has 14 zero hours in the window, `stablecoin` 91 of its 241
hours overall. The window also ends at 2 October 08:00, where GDELT stops, so
39 of its 168 hours are missing for every topic.

Neither the minimum nor a topic's query is changed to bring a topic in: both
are part of the hypothesis set, and changing them after seeing which topics
fall short would be choosing the hypothesis after seeing the data. A topic
enters when its window holds 96 changes, which needs GDELT to resume.

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
that cannot drop triggers. A database superuser can still rewrite it, which is
what the anchors are for.

**Anchors** (`ENABLE_DISCOVERY_ANCHOR`). After each scan the worker sends the
chain hash of the newest discovery to each calendar in
`DISCOVERY_ANCHOR_CALENDARS` that does not hold it yet, and stores the
calendar's receipt in `discovery_anchors`, which is append-only. The calendars
are public OpenTimestamps servers; each commits what it receives to a Bitcoin
block, usually within a few hours.

```text
what is sent      the 32 bytes of one chain hash, to each calendar
what it proves    that the chain had reached that discovery by the time of
                  the block. A chain hash commits to every earlier discovery,
                  so one anchor covers the chain up to that row
what it does not  that a discovery is true, or anything about a discovery
                  made after the anchored head
```

A third party needs no account:

```text
GET /v1/discovery-chain?from=AEX-<n>         links: fingerprint, detectedAt,
                                             prevChainHash, chainHash
GET /v1/discovery-chain/anchors              which heads were sent where, when
GET /v1/discovery-chain/anchors/<id>.ots     the proof file
```

They recompute each link as
`sha256(prevChainHash + '|' + fingerprint + '|' + detectedAt)` from the
discovery in question up to the anchored head, then run
`ots verify -d <chain hash> <file>.ots` with the standard client. These
endpoints return hashes and timestamps only, never which series a discovery
relates.

Limits. A receipt is stored as the calendar returned it and is pending until
the block is mined; AEGIX does not upgrade it, the client does
(`ots upgrade`), and that depends on the calendar still serving the
commitment. A discovery is covered only from the first anchored head at or
after it: with a scan a day, up to a day after it was detected, and never if
anchoring was off and no later discovery was anchored. The detail view says
which it is.

## 6. Operating it

```sh
ENABLE_REWIND_CAPTURE=true     # worker: start the ledger
ENABLE_REWIND=true             # API: expose replays
ENABLE_DISCOVERY=true          # worker scan + API
REWIND_CAPTURE_INTERVAL_SECONDS=900
ENABLE_TOKENIZED_STOCK_CAPTURE=true   # worker: Solana RPC, 2 calls per sweep
ENABLE_NARRATIVE_CAPTURE=true         # worker: GDELT, hourly
ENABLE_NARRATIVE_CONTEXT_CAPTURE=true # worker: GDELT Context, 3 requests per sweep
ENABLE_OPTIONS_CAPTURE=true           # worker: Cboe delayed, hourly, unlicensed
ENABLE_SECTOR_CAPTURE=true            # worker: Cboe delayed, 16 requests an hour
                                      # in session, unlicensed
ENABLE_DISCOVERY_DAILY=true           # worker: the daily-resolution scan
ENABLE_DISCOVERY_ANCHOR=true          # worker: chain head to OpenTimestamps
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
packages/rewind      unit: lock, checkpoints, convergence, coverage verdicts,
                     a discovery stamped at or after the event refused
packages/discovery   unit: BY q-values, effective sample size, no discovery on
                     independent series, planted relationship found at its lag,
                     known relationship rejected, no read past the epoch,
                     confirmation flow; the daily profile finds a planted
                     daily relationship and has no change across a weekend;
                     proof file layout and calendar submission
packages/sources     unit: pool price decode in both token orders, identity
                     checks that refuse a wrong account, GDELT hourly
                     aggregation and request spacing, options chain
                     attribution
tests/e2e-d14.ts     PostgreSQL: append-only triggers, backdating refused,
                     capture idempotency, Rewind lock through the API,
                     discoveries read under that lock with their status then,
                     tokenized stock capture and replay, Discovery ID chain,
                     read API, feature gates; anchors stored once per
                     calendar and append-only, a chain link recomputed from
                     the public endpoint, the proof file download
```

`pnpm test:e2e-d14` is part of `pnpm release:gate` and CI.
