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

**The four directions below have no engine and no data source.** They are
stated as design intent and marked the same way on the website (`/markets`,
`/roadmap`).

- **Narrative Radar** — detect when a theme moves from noise to momentum to
  market attention to consensus.
- **Anomaly Detector** — surface activity that deviates from historical
  expectation across price, volume, sector behavior and relative
  performance. The output is "pay attention", never "buy" or "sell". This is
  the market-domain detector; the repository has no historical baseline store
  for it.
- **Cross-Market Intelligence** — map relationships between on-chain
  activity, crypto assets, sectors, public companies, ETFs and macro
  signals.
- **Signal Engine** — aggregate independent indicators and report
  convergence with an explicit confidence value.

**What it would take.** A licensed market data source, a historical store for
baselines, and an extension of the graph node types to `SECTOR`, `COMPANY`,
`ETF` and `NARRATIVE`. None of these exist in the repository today. Until
they do, the market sections of any public copy must stay marked as
in development.

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
today", portfolio-level reasoning — is **PLANNED**. `packages/explanation`
additionally produces deterministic, template-based explanations for every
signal and path today; that is not an AI layer and must not be described as
one. No score or signal depends on an LLM.

---

## 7. Wallet Reputation API — PLANNED

Infrastructure update: `packages/network` now validates versioned evidence
digests and trusted reviewer signatures, including expiry and revocation.
No labelled production dataset or calibrated reputation model is supplied;
public scoring remains planned. See [network foundation](network-foundation.md).

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

## 8. $AEX token — PLANNED

The intended economic layer of AEGIX, coordinating verification, staking,
network security, research incentives, ecosystem participation and
governance, across five utilities: validator staking, data verification,
research bounties, ecosystem incentives and governance. $AEX is not required
for basic access to AEGIX's consumer products.

**Current state: internal accounting foundation only.** `packages/network`
provides atomic, replay-protected transfers between pre-funded internal accounts.
This is not an on-chain token implementation. No token, no contract, no staking
or slashing logic, no verification market, no governance mechanism, and no
tokenomics document. Treat token utility statements in this section as intent, and do not present
$AEX as operational anywhere in public copy.

---

## 9. Why Solana

High throughput, low transaction cost, large on-chain activity, a fast-moving
ecosystem and a lot of real-time data — the right starting point for
intelligence over high-frequency on-chain activity. Solana is where AEGIX
starts; the architecture is designed with multi-chain expansion in mind, and
multi-chain privacy analysis is **PLANNED**. An opt-in infrastructure package now
supports finalized raw block ingestion for Solana mainnet, Ethereum and Base;
EVM normalization and privacy analysis are not implemented.

---

## 10. Roadmap — status, not dates

The machine-checkable source of truth is the `products` list in
`apps/web/src/lib/site.ts`. `/roadmap`, the landing status surfaces, the
`/privacy` status list and the navigation badges are all derived from it, so
they cannot disagree with each other. This table mirrors that list;
per-item qualifiers — a shipped capability that is gated, or one whose input
does not exist yet — are shown beside the item on `/roadmap`.

| Status | Capability |
|---|---|
| SHIPPED | Intelligence core, Wallet X-Ray, Attack My Wallet, Compare Intelligence, Privacy Monitor, Wallet Context, Ask AEGIX (provider-gated), Developer Intelligence API, signed webhooks, population commonality (sufficiency-gated), Market Intelligence (BTC/ETH/SOL) |
| CURRENT | Public product launch, multi-user production hardening, documentation, infrastructure |
| NEXT | Narrative Radar, Anomaly Detection, Signal Engine, Cross-Market Intelligence |
| LATER | AI Intelligence Copilot, Wallet Reputation, Intelligence Network, $AEX economic layer, multi-chain |

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
