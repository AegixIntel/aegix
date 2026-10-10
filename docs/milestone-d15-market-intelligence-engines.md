# Milestone D15 — Narrative Radar, Anomaly Detection, Signal Engine, Cross-Market Intelligence

Written for: engineers working on this repository, and operators deciding when
to switch any of the four on.

D15 gives the four market directions that were listed as IN DEVELOPMENT a
first engine each. All four read what D14 already stores: the observation
ledger and the signal captures.

The safety property:

> **`ENABLE_ANOMALY_CAPTURE`, `ENABLE_ANOMALY_DETECTION`,
> `ENABLE_NARRATIVE_RADAR`, `ENABLE_SIGNAL_ENGINE` and `ENABLE_CROSS_MARKET`
> all default to `false`. Migration 0018 only lets a signal capture belong to
> one more domain. Nothing here changes an existing deployment until an
> operator opts in.**

No existing engine, score, API contract or stored row is changed. The four
products stay IN DEVELOPMENT in `apps/web/src/lib/site.ts`, with no link, until
they are on in production and have a record to show: a status is not upgraded
because the code exists.

---

## 0. What is and is not built

Built:

```text
Narrative Radar     GET /v1/narratives, /app/narratives — eight fixed news
                    topics, each accelerating, steady or fading against its
                    own two days, in articles per hour
Anomaly Detection   a worker sweep that stores one reading per series per
                    hourly change; GET /v1/anomalies, /app/anomalies
Signal Engine       GET /v1/signals, /app/signals — every stored signal of
                    every domain on one timeline, and the moments three or
                    more market classes held one within six hours
Cross-Market        GET /v1/cross-market, /app/cross-market — returns,
                    breadth and a week of correlation across crypto assets,
                    tokenized stocks and sector and commodity funds
```

Not built, and not claimed:

```text
sentiment, social media     narrative is still how much is published
stages of a narrative       "noise, momentum, attention, consensus" is the
                            design intent; the radar has three states
anomalies in session data   options and funds trade about 6.5 hours a day
                            and cannot fill an hourly baseline; not read
a tested confluence         the Signal Engine reports that signals
                            coincided. Nothing has tested that a coincidence
                            means anything, so it carries no confidence value
exchange equity prices,     not read. A class is the members AEGIX captures
macro series
a licensed data source      the fund prices are the Cboe delayed website
                            feed, as in D14 §4a
backfilled anomalies        impossible by the rule of D14 §2: a reading is
                            made once, when the hour is first seen
```

## 1. Narrative Radar

`narrative-radar-v1.0.0`, `packages/sources/src/narrative-radar.ts`.

Reads `narrative:<topic>:context_mentions`, the hourly article counts the
GDELT Context source stores (D14 §4a), for the eight topics of
`NARRATIVE_TOPICS`. The hours compared are the context signal engine's: the
newest six settled hours against the forty-eight before them.

```text
ACCELERATING        recent mean >= 2x the baseline mean, and >= 3 articles
                    an hour. The same rule that stores NARRATIVE_ACCELERATION
FADING              recent mean <= 0.5x the baseline mean, and the baseline
                    was >= 3 articles an hour
STEADY              measured, and neither
INSUFFICIENT_DATA   fewer than 4 recent or 24 baseline hours on record
```

The state is measured when the page is asked for, from the counts on record.
It is a reading of now, not a replay. What is listed under a topic as stored
signals is different: those are the `NARRATIVE` captures of
`ENABLE_CONTEXT_SIGNAL_CAPTURE` and the `ANOMALY` captures on the topic's
series, stamped when they were made, and they do not change.

An hour with no row is left out of both means: the ledger cannot say whether
it held no article or was not read. The answer says whether the capture it
reads is switched on.

## 2. Anomaly Detection

`anomaly-v1.1.0`, `packages/sources/src/anomaly.ts`,
`captureSeriesAnomalies` in the worker.

This product waited for a historical baseline store. The ledger is one.

```text
change       the newest completed hour's log-change of a series: the last
             observation of the hour against the last of the hour before,
             both from the same source
baseline     the same series' hourly changes of the 336 hours before, from
             that source; at least 96 of them
spread       the larger of two estimates of one standard deviation:
             median absolute deviation / 0.6745, and
             1.2533 x mean absolute deviation, both about the median
score        (change - median) / spread
anomaly      |score| >= 3.5 -> SERIES_ANOMALY_UP or SERIES_ANOMALY_DOWN
```

The median absolute deviation is used so that one earlier spike does not
widen the baseline and hide the next one. It is not used alone. A series that
stands still most hours and moves in a few, such as a token priced in one
thinly traded pool, has a median deviation near zero, and `anomaly-v1.0.0`
scored a 1.5% hour of such a series at fifteen thousand deviations. The mean
absolute deviation counts the hours the series did move. A baseline that
never moved cannot rank a change and is stored as a capture with LOW quality
and no signal.

Readings stored by `anomaly-v1.0.0` (production, 8 October 2026) are kept,
as every capture is, and counted in the coverage. The API lists only readings
of the current engine version.

**Stored once, at capture time.** A capture is a `signal_captures` row with
domain `ANOMALY`, the series key as its subject and the hour the change ends
in as its bucket, so a later sweep stores nothing for that hour again. A
capture that found nothing is stored too: without it, "nothing unusual" and
"nobody was looking" could not be told apart. A change more than six hours
old is not captured, so switching the capture on does not write the past.

**Which series.** The ones captured every hour of the week, and only while
their own capture is on:

```text
read         BTC, ETH, SOL price and rolling 24h volume; tokenized stock
             pool prices; news mentions per hour
not read     token supply (flat most hours), the share-of-news reading
             (zero hours), options and funds (US session only)
```

A change across two providers is never taken: two providers' levels differ
by a constant (D14 §4b measured 26 to 36 percent on volume), and the seam
would be one large simultaneous anomaly in several series.

The sweep runs at the capture interval and reads about two weeks of ledger
for every series in one query. With every source on it adds about 28 series
x 24 hours, so roughly 670 captures a day; like the other D14 tables these
cannot be pruned.

## 3. Signal Engine

`signal-engine-v1.0.0`, `packages/sources/src/signal-feed.ts`.

A reading of rows already on record, like the clusters of the Discovery
Engine: it runs no signal engine, stores nothing, and has no ID of its own.
Every signal on it was computed and stamped by the engine of its own domain.

```text
timeline     one entry per subject per signal type in the window, with the
             first and last capture that held it and the strongest one's text
class        CRYPTO, TOKENIZED_EQUITY, NEWS, SECTOR_FUND, COMMODITY_FUND.
             An anomaly belongs to the class of its series
confluence   a capture for which the six hours ending at it hold signals of
             at least three classes; confluent captures less than six hours
             apart are one episode
```

The window is 24 hours by default and at most 168. One answer reads the
newest 5,000 captures that held a signal and says when the window held more.

**What a confluence is not.** It is not a test and has no confidence value.
Classes that share a trading day move in the same hours for reasons that
have nothing to do with each other, and with five classes and a six-hour
window some coincidence is expected. It is shown as a moment worth looking
at, and the page says it claims no link.

## 4. Cross-Market Intelligence

`cross-market-v1.0.0`, `packages/sources/src/cross-market.ts`.

Measured on the ledger when asked for; nothing is stored.

```text
members        each class's series: price now, return over 24 hours and over
               7 days. "Now" is a price at most 3 hours old; a reference
               price is the last one at or before its mark, at most 3 hours
               before it, from the same source as the newest price
funds          today's last read price against the previous session's last
               read price, once the fund has traded today
class          median of its members' returns, and how many rose
correlation    Pearson r of two classes' mean hourly log-changes over 168
               hours, for classes priced around the clock, with at least 96
               shared hours
sectors        each sector fund's day against the median sector fund
```

Three plain readings are derived, each with its threshold in the engine
version: two classes whose median days have opposite signs and are each at
least 1 percent (`CLASS_DIVERGENCE`), and 80 percent of the members priced
around the clock moving the same way on the day (`BROAD_ADVANCE`,
`BROAD_DECLINE`).

**Limits.** A class is the members AEGIX captures: three crypto assets,
tokenized stocks priced in one on-chain pool each, and sixteen funds. A
correlation describes one week; it is not corrected for the number of pairs
and is not a tested relationship, which is what the Discovery Engine is for.
A fund's day and a crypto asset's last 24 hours are not the same period. The
fund prices rest on the Cboe delayed feed, which carries no redistribution
licence: this view is for signed-in users of a deployment whose operator
switched that feed on, and nothing read from it should back a public claim.

## 5. Schema

Migration `0018_anomaly_captures.sql`: the `signal_captures` domain check
accepts `ANOMALY` beside `MARKET`, `NARRATIVE` and `SECTOR`. No table, no
index, no change to an existing row. The append-only triggers stay.

## 6. Operating it

```sh
ENABLE_ANOMALY_CAPTURE=true      # worker: store anomaly readings from now on
ENABLE_ANOMALY_DETECTION=true    # API: /v1/anomalies
ENABLE_NARRATIVE_RADAR=true      # API: /v1/narratives
ENABLE_SIGNAL_ENGINE=true        # API: /v1/signals
ENABLE_CROSS_MARKET=true         # API: /v1/cross-market
```

Each read flag is independent. What an answer holds depends on the D14
captures:

```text
Narrative Radar     needs ENABLE_NARRATIVE_CONTEXT_CAPTURE; the stored
                    signals under a topic need ENABLE_CONTEXT_SIGNAL_CAPTURE
Anomaly Detection   needs ENABLE_ANOMALY_CAPTURE on the worker and at least
                    96 hourly changes of a series on record
Signal Engine       holds the domains whose capture is on; with only the
                    market capture it is the market signals on a timeline
                    and can never show a confluence
Cross-Market        shows the classes whose price capture is on
```

Turn the anomaly capture on first: the page has nothing to list before the
first capture, and its record begins that day.

The pages are in the signed-in app's navigation whether or not the flags are
set; a page whose flag is off says so. The public product status does not
change with this milestone.

**Amended 10 October 2026**: Anomaly Detection was raised from `IN DEVELOPMENT`
to `LIVE`, the one status this milestone left open. Its condition — that the
corrected engine have a record to show — was met: production held 1,419 anomaly
captures over 28 subjects from 8 October, 175 of them holding a signal, and the
read API listed readings of `anomaly-v1.1.0` alone. The other three products
were already `LIVE` at the time of the milestone.

## 7. Verification

```text
packages/sources     unit: an anomaly found in each direction, an ordinary
                     hour, an earlier spike not hiding the next, short and
                     flat baselines, the unfinished hour, no change across
                     two providers; radar states and ordering; feed entries,
                     a confluence, classes too far apart, separate episodes;
                     class returns, breadth, correlation, a stale price,
                     sector ranking, the three readings
tests/e2e-d15.ts     PostgreSQL: the five gates and the session; anomaly
                     captures stored once per hourly change and append-only,
                     the quiet and the unmeasured ones stored too; the four
                     read APIs over the ledger and the captures
```

`pnpm test:e2e-d15` is part of `pnpm release:gate` and CI.
