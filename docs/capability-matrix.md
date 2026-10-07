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
| Narrative Radar | IN DEVELOPMENT | Built (D15), default off: `ENABLE_NARRATIVE_RADAR`. Reads the hourly article counts `ENABLE_NARRATIVE_CONTEXT_CAPTURE` stores for eight fixed topics; the signals listed under a topic additionally need `ENABLE_CONTEXT_SIGNAL_CAPTURE`. Not switched on in production. See `docs/milestone-d15-market-intelligence-engines.md`. |
| Anomaly Detection | IN DEVELOPMENT | Built (D15), default off. The worker stores a reading per series per hourly change behind `ENABLE_ANOMALY_CAPTURE`; the read API needs `ENABLE_ANOMALY_DETECTION`. The baseline is the observation ledger, and a series needs 96 hourly changes on record before it is measured. The record begins when the capture is switched on; it is not on in production. The market-domain 3σ signal inside Market Intelligence is a different thing. |
| Signal Engine | IN DEVELOPMENT | Built (D15), default off: `ENABLE_SIGNAL_ENGINE`. A reading of the signal captures the other engines stored; it holds only the domains whose capture is on. Not switched on in production. |
| Cross-Market Intelligence | IN DEVELOPMENT | Built (D15), default off: `ENABLE_CROSS_MARKET`. Compares the classes whose price capture is on. Sector and commodity funds come from the unlicensed Cboe delayed feed; there is still no licensed market data source. Not switched on in production. |
| AEGIX Rewind | LIVE | Default off. Capture needs `ENABLE_REWIND_CAPTURE` (and `ENABLE_MARKETS`) on the worker; the read API needs `ENABLE_REWIND`. Tokenized stocks additionally need `ENABLE_TOKENIZED_STOCK_CAPTURE`. A replay reaches back only as far as the first stored capture, which in production is 1 October 2026. See `docs/milestone-d14-rewind-discovery.md`. |
| AEGIX Discovery Engine | LIVE | Default off (`ENABLE_DISCOVERY`). Needs the ledger to hold both a test and a baseline window (14 days) before any hypothesis is tested; in production those days were read back from CoinGecko and GeckoTerminal for market and tokenized stock prices (milestone doc §4b). Scans only the series whose capture is on: market assets (`ENABLE_REWIND_CAPTURE`), tokenized stocks over Solana RPC (`ENABLE_TOKENIZED_STOCK_CAPTURE`), GDELT news volume and hourly mention counts (`ENABLE_NARRATIVE_CAPTURE`, `ENABLE_NARRATIVE_CONTEXT_CAPTURE`), Cboe delayed options (`ENABLE_OPTIONS_CAPTURE`) and Cboe delayed sector and commodity fund prices (`ENABLE_SECTOR_CAPTURE`); the two Cboe sources are an unlicensed website feed and are off in production. A daily-resolution scan (`ENABLE_DISCOVERY_DAILY`) reads the session series and has tested nothing yet: it needs about four months of daily observations. The Discovery ID chain head can be anchored to public OpenTimestamps calendars (`ENABLE_DISCOVERY_ANCHOR`), with the chain and proof files readable without a session (milestone doc §5). |
| AI Intelligence Copilot | IN DEVELOPMENT | Built (D16), default off: `ENABLE_AI_COPILOT` **and** a configured LLM provider, as for Ask AEGIX; without a credential the route returns `MISSING_CREDENTIAL`. It reads only the products whose own flag is on (`ENABLE_SIGNAL_ENGINE`, `ENABLE_NARRATIVE_RADAR`, `ENABLE_CROSS_MARKET`, `ENABLE_DISCOVERY`) and shares the Ask AEGIX daily limit. It explains stored evidence; no score or signal depends on an LLM. Not switched on in production. See `docs/milestone-d16-ai-copilot.md`. |
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
