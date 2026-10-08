# Milestone D16 — AI Intelligence Copilot

Written for: engineers working on this repository, and operators deciding
whether to switch it on.

D16 adds one route and one page: a question answered from what AEGIX's
engines already have on record across its products.

The safety property:

> **`ENABLE_AI_COPILOT` defaults to `false`. There is no migration. No score,
> signal, anomaly, discovery or stored row depends on a model, and none is
> changed by one.**

The copilot is Ask AEGIX (D9) with a wider evidence block. Everything that
made Ask AEGIX safe is the same code: the bounded context, the sanitised
question, the citation check, and the removal of statements that cite nothing
AEGIX issued.

---

## 1. What is and is not built

Built:

```text
POST /v1/copilot/ask   { question, wallet? } — signed in, rate-limited,
                       metered against the Ask AEGIX daily limit
/app/copilot           the question, each statement with the evidence it
                       cites, what was read and what was removed
```

Not built, and not claimed:

```text
memory                 every question stands alone; nothing is kept between
                       two questions
portfolio reasoning    one wallet at most, and only its completed analysis
anything computed      the model is given text the engines produced. It
                       reads no chain, no market and no ledger
a cause                "why did it move" has an answer only if an evidence
                       item states one, and none does
```

## 2. What the model is shown

Each product is read only when its own flag is on. A product that is off is
named as not read, in an evidence item the model sees.

```text
flag                     read                             evidence IDs
ENABLE_SIGNAL_ENGINE     stored signals of the last 24    sig:<domain>:<subject>:<type>
                         hours, every domain, and their   ind:confluence:<n>
                         confluences
ENABLE_DISCOVERY         the ten newest discoveries,      sig:discovery:AEX-<n>
                         with their status
ENABLE_NARRATIVE_RADAR   each measured topic's standing   ind:narrative:<topic>
ENABLE_CROSS_MARKET      each measured class, the         ind:cross:<class>
                         readings and the correlations    ind:cross:reading:<n>
                                                          ind:cross:correlation:<a>:<b>
always                   what was read, what was not,     cov:record
                         and the capture counts
wallet named             that wallet's analysis, as Ask   as Ask AEGIX issues them
                         AEGIX builds it
```

What was not measured is not offered: a topic with too few hours on record, a
class with no measured member, a correlation with too few shared hours.

The block is bounded at 40 items and 12,000 characters, ranked by severity
times confidence as in Ask AEGIX. When items do not fit, the model is told
how many were left out and the answer reports it.

## 3. What comes back

The model must answer in the fixed structure and cite an evidence ID for
every statement. Then, before anything reaches the caller:

```text
a citation of an ID that was not in the block   removed
a statement left with no citation               removed
a statement that names an owner, calls a        removed
wallet safe or malicious, or advises or
predicts
```

The summary is rebuilt from the statements that survive, so a summary cannot
say what a removed statement said. The response carries the counts of both
removals, the list of IDs offered, and what each stands for.

The copilot's instructions (`COPILOT_SYSTEM_PROMPT`) add the limits its wider
record needs: signals that coincide are not linked, a discovery is not
causation, a week's correlation describes that week, article counts are not
sentiment, a tokenized stock's price is one pool, and a fund's price is not
the price of what it holds.

## 4. Operating it

```sh
ENABLE_AI_COPILOT=true     # API: /v1/copilot/ask
```

It needs the provider Ask AEGIX uses (`LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_MODEL`). Without a credential the route answers `503 AI_UNAVAILABLE`
with reason `MISSING_CREDENTIAL`, before the daily limit is touched.

`docker-compose.production.yml` passes those three and `GROQ_API_KEY` to the
API from the operator's environment file. Until one of the keys is set there,
production has no provider: the copilot and Ask AEGIX both answer 503.

A question costs one of the caller's daily Ask AEGIX questions
(`ask.daily`), and is claimed before the provider is called, as there. A
provider outage costs this route and nothing else.

With none of the four product flags on, the copilot answers from `cov:record`
alone, which says nothing was read. Switch on what it should read first.

Chain-derived text reaches the model only through a named wallet's analysis,
and passes the same sanitisation as in Ask AEGIX. Signal, discovery and
radar text is written by AEGIX's engines from numbers.

## 5. Verification

```text
apps/api copilot.test.ts   unit: every product's record becomes evidence
                           with an ID the context accepts; what was not
                           measured is not offered; a product that is off is
                           named as not read; grounding against the block
tests/e2e-d16.ts           PostgreSQL, with a fixture model: the gates in
                           order, nothing reaching the model before they
                           pass; a stored signal in the block; an invented
                           citation and a prediction removed; metering; a
                           wallet with no analysis; a product that is off;
                           an outage
```

No real model was called in any test. What a real model does with this block
is not verified by this milestone: only that whatever it returns is held to
the evidence.

`pnpm test:e2e-d16` is part of `pnpm release:gate` and CI.
