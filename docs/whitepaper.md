# AEGIX — Financial & On-Chain Intelligence

**See What Others Don't.** Built on Solana.

**Status of this document:** canonical. Revised 2026-09-10 against the actual
repository. Every capability below carries one of three markers, and the
marker is checkable against code:

- **LIVE** — implemented, tested, and reachable through the API or the app.
- **IN DEVELOPMENT** — design direction with no engine behind it yet.
- **PLANNED** — not started; depends on inputs AEGIX does not yet have.

The earlier draft of this whitepaper carried calendar dates (Phase 0 in
August 2026 through Phase 8 in Q4 2027). Those dates were wrong in both
directions — Wallet X-Ray, Attack My Wallet and the Privacy Threat Monitor
all shipped ahead of them — so the roadmap is now status-driven, matching
`/roadmap` on the website. Do not reintroduce dates that the repository does
not support.

---

## 1. The problem

Markets generate more information every second than anyone can read: on-chain
activity, prices, volume, sector rotation, narratives, wallet behavior, macro
signals. Finding data is no longer the hard part. Understanding what it says
before it becomes obvious is.

Most platforms show what happened. AEGIX is built to address why it may be
happening, what is changing underneath, and which signals are beginning to
converge.

Public blockchains add a second problem in the same shape. A wallet address
carries no name, but its behavior reveals relationships: funding sources
connect wallets, repeated counterparties expose relationships, transaction
timing creates a behavioral fingerprint, and interactions with known entities
increase attribution exposure. AEGIX Privacy exists so a wallet owner can see
what an outside observer could infer from that.

## 2. The intelligence engine

### On-chain — LIVE

Wallet activity, transaction flows, entity relationships, token movements,
protocol activity, behavioral patterns and wallet clusters. Implemented
across `packages/blockchain`, `packages/normalizer`,
`packages/intelligence`, `packages/graph`, `packages/correlation` and
`packages/commonality`.

### Markets — LIVE, within a bounded slice

BTC, ETH and SOL price, 24h volume, a bounded hourly history, freshness and
deterministic signals, implemented in `packages/markets` and served by
`GET /v1/markets`, `GET /v1/markets/:asset` and `GET /v1/markets/:asset/ask`,
read at `/app/markets`. The provider is keyless and the response is cached
rather than persisted.

Stocks, ETFs, sectors, market breadth, historical correlation and the
sector/company/ETF/narrative graph are **IN DEVELOPMENT**: no engine and no
licensed data source exists for them. See §4.

### Macro and narratives — IN DEVELOPMENT

Market themes, sector rotation, cross-market movement, emerging narratives,
historical patterns and anomaly signals. No engine and no data source; this
is a direction, not a feature.

---

## 3. AEGIX Privacy — LIVE

> Know What the Blockchain Knows.

The privacy pillar is the part of AEGIX that is fully built. Its outputs are
explained, never bare: AEGIX must be able to say why it believes a wallet is
exposed, and it never returns an unexplained score.

### 3.1 Wallet X-Ray — LIVE

`GET /v1/wallets/:address/x-ray`

Produces a Privacy Exposure Score from 0–100 with a severity band, a
confidence value computed independently of the score, and the signals behind
both. The seven exposure dimensions are:

| Dimension | What it measures |
|---|---|
| Identity Linkability | Convergence of funding, counterparty, cluster and public-attribution evidence |
| Funding Exposure | Provenance and concentration of inbound value |
| Wallet Cluster Exposure | Counterparty overlap with other observed wallets |
| Behavioral Fingerprint | Activity-window narrowness, protocol concentration, interval regularity |
| Counterparty Exposure | Repetition and concentration across counterparties |
| Exchange / Entity Exposure | Interaction with addresses in the curated entity registry |
| Transaction Pattern Exposure | Outlier amounts, frequency, low-activity-window concentration, exact-amount reuse |

Public Attribution Signals are reported as their own signal category and
enter the score as a weighted component of Identity Linkability. The full
three-way mapping between whitepaper categories, signal categories and score
dimensions is in [signal-taxonomy.md](signal-taxonomy.md).

### 3.2 Attack My Wallet — LIVE

An adversarial privacy simulation rather than a transaction history. The
graph engine searches for paths by which a wallet could become correlated
with other addresses, entities or publicly attributable information, and
ranks the strongest ones with the evidence supporting each hop.

Path node types implemented today: `WALLET`, `ENTITY`, `PROTOCOL`,
`CLUSTER`, `PUBLIC_SIGNAL`. Every edge is classified `OBSERVED` or
`INFERRED` and carries its source engine, version and concrete evidence
references.

Correlation is not identity. AEGIX reports probabilistic intelligence and
confidence signals; it makes no claim about real-world ownership.

### 3.3 Compare Intelligence — LIVE

`POST /v1/compare`

Absent from earlier drafts of this whitepaper despite being a shipped
product. Correlates two wallets across funding provenance, temporal
behavior, entity overlap and inferred edges, and states how unusual the
result is against a population baseline
(`packages/correlation`, `packages/commonality`).

### 3.4 Privacy Threat Monitor — LIVE

A wallet's privacy profile is not static: new transactions create new
relationships, new counterparties create new correlations, new entity
interactions increase exposure. The monitor re-analyzes on a schedule,
diffs the result and raises events — new linkage, exposure increase, new
entity signal, behavioral change — delivered in-app, by email when enabled,
or to signed webhooks (`packages/monitor`, `packages/diff`,
`packages/webhook-delivery`).

Earlier drafts listed this as a future phase. It shipped.

### 3.5 Developer Intelligence API — LIVE

`/v1/developer/intelligence/*` with scoped API keys, rotation, revocation,
per-key quotas and usage reporting. Also absent from earlier drafts.

---

## 4. AEGIX Markets

**Shipped.** Market Intelligence for BTC, ETH and SOL: price, 24h volume, a
bounded hourly history, freshness and quality reporting, and five
deterministic signal types — price deviation, volume spike, volatility
expansion, momentum and anomaly (`packages/markets/src/signals.ts`). The
anomaly signal is a statistical outlier against a short price window; it is
not evidence of manipulation, and the product copy says so.

**The four directions below each have a first engine (D15), switched off by
default.** Narrative Radar, Cross-Market Intelligence and the Signal Engine
have been on in production since 8 October 2026. The Anomaly Detector has
captured since the same day; it stays marked in development on the website
(`/roadmap`) until its corrected engine has a record to show. Each line
says the design intent, then what the engine actually does; the two are not
the same size. See `docs/milestone-d15-market-intelligence-engines.md`.

- **Narrative Radar** — detect when a theme moves from noise to momentum to
  market attention to consensus. *Built:* for eight fixed news topics, whether
  the articles mentioning it per hour are accelerating or fading against the
  two days before. News volume only: no sentiment, no social media, no stages
  of attention.
- **Anomaly Detector** — surface activity that deviates from historical
  expectation across price, volume, sector behavior and relative
  performance. The output is "pay attention", never "buy" or "sell". *Built:*
  each hourly change of a crypto, tokenized stock or news series measured
  against that series' own two weeks in the observation ledger, which is the
  baseline store. Session-only series (options, funds) are not read.
- **Cross-Market Intelligence** — map relationships between on-chain
  activity, crypto assets, sectors, public companies, ETFs and macro
  signals. *Built:* returns, breadth and one week of correlation across the
  classes AEGIX captures: three crypto assets, tokenized stocks priced
  on-chain, and sector and commodity funds. No public companies' exchange
  prices and no macro signals.
- **Signal Engine** — aggregate independent indicators and report
  convergence with an explicit confidence value. *Built:* one timeline of the
  signals every engine stored, and the moments three or more market classes
  held one within six hours. It reports that they coincided and gives no
  confidence value, because nothing has tested that the coincidence means
  anything.

**What it would still take.** A licensed market data source: the fund and
options prices come from an exchange's delayed website feed with no
redistribution licence, and nothing read from it should back a public claim.
And an extension of the graph node types to `SECTOR`, `COMPANY`, `ETF` and
`NARRATIVE`, which does not exist.

---

## 5. AEGIX Graph

Implemented today: a relationship graph over wallets, entities, protocols and
clusters, with observed/inferred edge classification and bounded path search.

The whitepaper's wider structure — wallet → token → protocol → sector →
company / ETF / narrative — is **PLANNED**. The crypto half exists; the
traditional-market half depends on the market data work in §4.

---

## 6. AEGIX AI — LIVE when a provider credential is configured

Ask AEGIX answers questions grounded in the deterministic evidence AEGIX has
already issued: `POST /v1/wallets/:address/ask` and
`POST /v1/markets/:asset/ask`, surfaced inside Wallet Context and Markets
(`packages/ai`). It is reached through an OpenAI-compatible provider
configured by `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`, with Groq
available by pointing the base URL at its OpenAI-compatible path. With no
credential configured the route reports `MISSING_CREDENTIAL` rather than
answering. Answers are validated against the supplied evidence and citations
are enforced, so the model explains findings and decides none of them.

The wider **AI Intelligence Copilot** — explaining an anomaly, "what changed
today", portfolio-level reasoning — has a first version (D16,
`POST /v1/copilot/ask`), switched off by default and on in production since
8 October 2026:
one question answered from the signals, anomalies, discoveries, news coverage
and cross-market view already on record, plus one wallet's analysis when the
caller names it. It is the same grounded machinery as Ask AEGIX over a wider
evidence block. There is no portfolio-level reasoning and no memory between
questions. `packages/explanation` additionally produces deterministic,
template-based explanations for every signal and path today; that is not an
AI layer and must not be described as one. No score or signal depends on an
LLM.

---

## 7. Wallet Reputation API — PLANNED

Infrastructure update: `packages/network` validates a claim against a
versioned, domain-tagged payload (`AEGIX_REPUTATION_CLAIM_V1` plus a dataset
version), a sha256 evidence digest, and Ed25519 signatures from an
operator-controlled reviewer policy with a quorum, expiry and revocation
(`packages/network/src/reputation.ts`). The digest itself is a plain sha256
over the evidence blob — the versioning lives in the claim payload. No
labelled production dataset or calibrated reputation model is supplied, so
`reputationReport` returns `score`, `riskBand` and `confidence` as null and
says why; public scoring remains planned. See
[network foundation](network-foundation.md).

Reputation intelligence for on-chain applications: a reputation value, a risk
band, wallet age, behavioral consistency, fraud signals and a confidence
value, for use in DeFi, lending, OTC, marketplaces, DAOs, gaming and
prediction markets. The long-term aim is trust without unnecessary
identification.

**What it would take.** Bounded observed age/history depth, behavioral
consistency and confidence are derivable from data AEGIX already holds; a
lifetime wallet age is not guaranteed by bounded RPC history. Fraud signals are not — there is no
labelled fraud dataset in the repository, and inventing one would produce a
number that looks authoritative and means nothing. This stays planned until
that input exists.

---

## 8. $AGX token — issued; economic layer PLANNED

**The token exists.** AEGIX ($AGX) is a Solana SPL Token-2022 mint,
`8KQjhn6PfkWK58aFUrwuMo9yZEJpGMSbmFB1ZBXApump`, launched through pump.fun
(<https://pump.fun/coin/8KQjhn6PfkWK58aFUrwuMo9yZEJpGMSbmFB1ZBXApump>). Read
from the mint on 20 November 2026: name `AEGIX`, symbol `AGX`, 6 decimals, a
supply of about 1 billion. It replaces the earlier working name $AEX.

**The economic layer is not built.** The intent is for $AGX to coordinate
verification, staking, network security, research incentives, ecosystem
participation and governance, across five utilities: validator staking, data
verification, research bounties, ecosystem incentives and governance. None of
them exists. No AEGIX product reads, requires, charges or rewards $AGX: there
is no staking or slashing logic, no verification market, no governance
mechanism and no tokenomics document, and basic access to the consumer products
will not require the token.

`packages/network` keeps an internal, pre-funded accounting ledger with atomic,
replay-protected transfers. Its units are bookkeeping, not $AGX: nothing moves
between that ledger and the mint. Treat the utility statements in this section
as intent, and present $AGX in public copy only as an issued token with no
in-product utility yet.

---

## 9. Why Solana

High throughput, low transaction cost, large on-chain activity, a fast-moving
ecosystem and a lot of real-time data — the right starting point for
intelligence over high-frequency on-chain activity. Solana is where AEGIX
starts; the architecture is designed with multi-chain expansion in mind, and
multi-chain privacy analysis is **PLANNED**. Multi-Chain intelligence is **LIVE**
for Ethereum mainnet and Base: continuous followers keep rolling windows of
about 4,300 (Ethereum) and 43,200 (Base) recent finalized blocks, with receipts,
ETH and ERC-20/ERC-721 transfers, and wallet signals that carry no score. EVM
privacy analysis is not implemented.

---

## 10. Roadmap — status, not dates

The machine-checkable source of truth is the `products` list in
`apps/web/src/lib/site.ts`. `/roadmap`, the landing status surfaces, the
`/privacy` status list and the navigation badges are all derived from it, so
they cannot disagree with each other. This table mirrors that list;
per-item qualifiers — a shipped capability that is gated, or one whose input
does not exist yet — are shown beside the item on `/roadmap`. What each
capability needs in order to actually operate — the flag, credential or input
it depends on — is in [capability-matrix.md](capability-matrix.md).

| Status | Capability |
|---|---|
| SHIPPED | Intelligence core, Wallet X-Ray, Attack My Wallet, Compare Intelligence, Privacy Monitor, Wallet Context, Ask AEGIX (provider-gated), Developer Intelligence API, signed webhooks, population commonality (sufficiency-gated), Market Intelligence (BTC/ETH/SOL), AEGIX Rewind and AEGIX Discovery Engine (market assets and on-chain tokenized stocks; captures begin 1 October 2026, and the Discovery Engine's earlier hourly history was read back from providers), Narrative Radar, Signal Engine, Cross-Market Intelligence and AI Intelligence Copilot (first versions, on since 8 October 2026), Anomaly Detection (capturing since 8 October 2026) and Intelligence Network (over the finalized blocks it actually ingested), Saved Wallets and Comparisons, Notifications (in-app), Plan & Usage (manual provisioning) and Multi-Chain (Ethereum and Base mainnet over rolling windows of recent finalized blocks, with transfers and wallet signals) |
| CURRENT | Public product launch, multi-user production hardening, documentation, infrastructure |
| NEXT | Nothing in development. |
| LATER | Wallet Reputation, $AGX economic layer (the token is issued; no utility is built), EVM privacy analysis |

---

## 11. Positioning

1. **One intelligence engine.** Privacy, wallet behavior, market anomalies,
   narratives and cross-market relationships are designed around a shared
   engine rather than separate silos.
2. **More than a dashboard.** Data → relationship → pattern → signal →
   intelligence. Dashboards show; AEGIX interprets.
3. **Privacy and markets.** Understand what your wallet reveals; understand
   what markets are revealing. The privacy pillar is complete, and the market
   side is live only as BTC, ETH and SOL price, volume and deterministic
   signals — the wider market direction is not built.
4. **Cross-market vision.** Capital, narratives and sentiment move across
   ecosystems, and AEGIX is designed to map those relationships.
5. **Signal convergence.** The strongest insight rarely comes from one
   metric. It emerges when independent signals point the same way — which is
   exactly how the linkability engine already works.

## 12. The flywheel

More data → more relationships → better intelligence → more useful signals →
more users and applications → more data.

## 13. Epistemic commitments

These are not marketing lines; they are enforced in code and tests.

- A score is never returned without the signals that produced it.
- Confidence is computed independently of exposure.
- Observed evidence and inferred evidence are labelled as such and never
  merged.
- Statistical similarity alone cannot produce a linkability claim, and is
  capped so it cannot read as near-identification.
- Linkability confidence is capped below certainty. Correlation is not
  identity.
- Unavailable numbers render as `—`. AEGIX does not fabricate a value to
  fill a layout.

---

**AEGIX** — On-Chain Intelligence. Market Intelligence. Privacy
Intelligence. Built on Solana.
