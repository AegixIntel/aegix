# AEGIX capability matrix

What AEGIX actually runs, and under which conditions.

Two things are separated here on purpose:

- **Status** is the public product status. It has exactly one source of truth —
  the `products` list in `apps/web/src/lib/site.ts` — and everything public
  (`/roadmap`, the landing status surfaces, the `/privacy` status list, the
  navigation badges) is derived from it. The rows in the first table are copies
  of that list, and `apps/web/src/lib/site.test.ts` fails if they diverge.
- **Runtime condition** is what the capability needs in order to actually
  operate: a gate, a credential, an input, or a bound. A capability can be
  shipped and still be switched off or blocked, and saying so is part of the
  claim.

A status is never upgraded because the code for a capability exists. An unbuilt
capability carries no link, because a link would be a promise the repository
cannot keep.

## Product capabilities

| Capability | Status | Runtime condition |
|---|---|---|
| Privacy Intelligence | LIVE | The privacy pillar page (`/privacy`). Composed of the products below. |
| Wallet X-Ray | LIVE | Solana RPC reachable and a completed analysis. `ENABLE_NEW_ANALYSES` is the admission kill switch. |
| Attack My Wallet | LIVE | An existing analysis. `ENABLE_ATTACK_MY_WALLET`; path and multi-hop exploration are bounded by `ENABLE_MULTI_HOP_GRAPH` and the `GRAPH_MAX_*` budgets. |
| Compare Intelligence | LIVE | Two analyzed wallets. `ENABLE_CORRELATION_ANALYSIS`; saved pairs additionally need `ENABLE_SAVED_COMPARISONS`. |
| Privacy Monitor | LIVE | Worker plus scheduler (`ENABLE_MONITORING`, `ENABLE_MONITOR_SCHEDULER`). In-app notifications always; email only when `EMAIL_ENABLED` and `ENABLE_EMAIL_NOTIFICATIONS` are both on and a verified destination exists. |
| Wallet Context | LIVE | A completed analysis; a read over persisted results, so it consumes no analysis quota. `ENABLE_WALLET_CONTEXT`. |
| Ask AEGIX | LIVE | `ENABLE_ASK_AEGIX` **and** a configured LLM provider (`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`). Without a credential the route returns `MISSING_CREDENTIAL` rather than answering. Embedded in Wallet Context and Markets; there is no standalone route. |
| Developer Intelligence API | LIVE | `ENABLE_DEVELOPER_API` and `ENABLE_DEVELOPER_INTELLIGENCE_API`, plus an API key within its entitlement, scope and daily quota. |
| Signed Webhooks | LIVE | `ENABLE_WEBHOOK_DELIVERY`, a configured endpoint, and `WEBHOOK_ENCRYPTION_KEY` — which production refuses to start without. |
| Population Commonality | LIVE | `ENABLE_POPULATION_COMMONALITY` defaults to **false**, and the penalty additionally requires the observed population to pass `COMMONALITY_MIN_POPULATION` and the snapshot freshness bound. The flag alone never activates it. |
| Intelligence Core | LIVE | The deterministic engine set (`packages/intelligence`, `packages/scoring`, `packages/graph`, `packages/correlation`). Not a generative layer. |
| Market Intelligence | LIVE | `ENABLE_MARKETS` and the keyless crypto provider. **BTC, ETH and SOL only**, over a bounded hourly window; responses are cached rather than persisted. |
| Narrative Radar | IN DEVELOPMENT | No engine and no data source. |
| Anomaly Detection | IN DEVELOPMENT | No standalone detector and no historical baseline store. A market-domain 3σ signal exists inside Market Intelligence; it is not this product. |
| Signal Engine | IN DEVELOPMENT | Signal engines exist inside the intelligence and markets packages. The cross-market aggregator this product describes does not. |
| Cross-Market Intelligence | IN DEVELOPMENT | No engine and no licensed market data source. |
| AEGIX Rewind | LIVE | Default off. Capture needs `ENABLE_REWIND_CAPTURE` (and `ENABLE_MARKETS`) on the worker; the read API needs `ENABLE_REWIND`. Tokenized stocks additionally need `ENABLE_TOKENIZED_STOCK_CAPTURE`. A replay reaches back only as far as the first stored capture, which in production is 1 October 2026. With `ENABLE_DISCOVERY` on, a replay of an asset also lists the Discovery IDs on that asset's series that were stamped before the event time; they do not enter the verdict. See `docs/milestone-d14-rewind-discovery.md`. |
| AEGIX Discovery Engine | LIVE | Default off (`ENABLE_DISCOVERY`). Needs the ledger to hold both a test and a baseline window (14 days) before any hypothesis is tested; in production those days were read back from CoinGecko and GeckoTerminal for market and tokenized stock prices (milestone doc §4b). Scans only the series whose capture is on: market assets (`ENABLE_REWIND_CAPTURE`), tokenized stocks over Solana RPC (`ENABLE_TOKENIZED_STOCK_CAPTURE`), GDELT news volume and hourly mention counts (`ENABLE_NARRATIVE_CAPTURE`, `ENABLE_NARRATIVE_CONTEXT_CAPTURE`), Cboe delayed options (`ENABLE_OPTIONS_CAPTURE`) and Cboe delayed sector and commodity fund prices (`ENABLE_SECTOR_CAPTURE`); the two Cboe sources are a delayed website feed with no redistribution licence, on in production since 6 October 2026 so that their history accumulates, and backing no public claim until a licensed feed replaces them. A daily-resolution scan (`ENABLE_DISCOVERY_DAILY`, on in production since the same day) reads the session series and has tested nothing yet: it needs about four months of daily observations, so about February 2027. The Discovery ID chain head can be anchored to public OpenTimestamps calendars (`ENABLE_DISCOVERY_ANCHOR`), with the chain and proof files readable without a session (milestone doc §5). |
| AI Intelligence Copilot | PLANNED | Not implemented. `packages/explanation` produces deterministic, template-based explanations for signals and paths; it is not an AI layer and is not described as one. No score or signal depends on an LLM. |
| Wallet Reputation | PLANNED | Evidence verification is built; no calibrated model and no labelled dataset, so `reputationReport()` returns `score`, `riskBand` and `confidence` as `null`. |
| Intelligence Network | RESEARCH | Direction only. |
| $AEX Economic Layer | PLANNED | Internal accounting only: `mode: "INTERNAL_ACCOUNTING"`, `tokenLive: false`. No token, mint, contract, staking, slashing, verification market, governance mechanism or tokenomics document. |
| Multi-Chain | PLANNED | Finalized raw block ingestion supports Ethereum and Base, but EVM normalization and privacy analysis are not implemented. |

## Infrastructure and platform

These are real and shipped, but they are not products on the public status list,
so they carry a state rather than a product status.

| Capability | State | Runtime condition |
|---|---|---|
| Analysis pipeline | Shipped | Bounded on-demand RPC analysis with disclosed signature, transaction, RPC-call, history-day and execution-time budgets. Not a global Solana indexer. |
| Billing and entitlements | Shipped, manual provisioning | `ENABLE_BILLING` with `BILLING_PROVIDER=manual`: an operator grants a paid plan through `pnpm billing:grant`. Self-service checkout, a customer portal and payment-provider webhooks are post-launch scope. |
| Finalized-block ingestion | Implemented, off by default | `ENABLE_INDEXED_TRANSACTIONS=false`. Operator-run CLI, never deployed; an 85-minute live run fell behind mainnet and did not recover on a free endpoint. |
| Network read APIs | Implemented, off by default | `ENABLE_NETWORK_API=false`. `/app/network` reports the feature as disabled on a deployment that has not enabled it. |
| Email notifications | Implemented, off by default | `EMAIL_ENABLED=false` and `ENABLE_EMAIL_NOTIFICATIONS=false`. Optional channel: skipping it never marks an event failed and never blocks in-app delivery. |

## Updating this document

Change a status in `apps/web/src/lib/site.ts`, not here — then mirror the row.
The test in `apps/web/src/lib/site.test.ts` compares this table against
`products` and fails on any divergence in either direction, including a stray
row that names something which is not a product.
