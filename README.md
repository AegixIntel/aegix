# AEGIX — On-Chain Privacy Intelligence

AEGIX is an on-chain privacy intelligence platform that helps wallet owners understand what publicly observable blockchain activity may reveal about them.

**Primary chain:** Solana
**Primary principle:** *See What Others Don't.*
**Privacy pillar principle:** *Know What the Blockchain Knows.*

> AEGIX must be able to explain why it believes a wallet is exposed. It never returns an unexplained score.

## Status

Product status has one source of truth: the `products` list in
`apps/web/src/lib/site.ts`. `/roadmap`, the landing status surfaces, the `/privacy`
status list and the navigation badges are all derived from it, so they cannot
disagree. Runtime conditions — what a capability actually needs in order to operate —
are in [docs/capability-matrix.md](docs/capability-matrix.md); the narrative version is
[docs/whitepaper.md](docs/whitepaper.md).

- **Live:** Wallet X-Ray, Attack My Wallet, Compare Intelligence, Privacy Monitor,
  Wallet Context, Ask AEGIX (requires a configured LLM provider), Developer Intelligence
  API, Signed Webhooks, Population Commonality (flag off by default, and additionally
  gated on population sufficiency), Market Intelligence (BTC, ETH and SOL only),
  AEGIX Rewind and the AEGIX Discovery Engine (both default off). Their series are
  BTC, ETH and SOL market data, tokenized stocks read from Solana and news volume by
  topic. Delayed options activity and sector and commodity fund prices are captured in
  production since 6 October 2026 from a feed with no redistribution licence; only a
  daily scan reads them, and it tests nothing before about February 2027
  (`docs/milestone-d14-rewind-discovery.md`). Narrative Radar, Signal Engine and
  Cross-Market Intelligence (first engines, default off;
  `docs/milestone-d15-market-intelligence-engines.md`), the AI Intelligence
  Copilot (default off, needs an LLM provider; `docs/milestone-d16-ai-copilot.md`),
  and Anomaly Detection (capturing since 8 October 2026; its first engine version
  was replaced the same day, and only the corrected one's readings are shown).
  Intelligence Network is live too, over a bounded window of finalized Solana
  blocks — see Network ingestion below. The account surfaces are part of the live
  product as well: Saved Wallets and Comparisons, Notifications (in-app) and
  Plan & Usage (manual provisioning).
  There is still no licensed market data source.
- **Planned:** Wallet Reputation, $AGX economic layer, multi-chain. The $AGX token
  itself is issued (Solana mint `8KQjhn6PfkWK58aFUrwuMo9yZEJpGMSbmFB1ZBXApump`);
  no product reads or requires it yet.

### Network ingestion

Finalized-block ingestion for Solana, the wallet history read APIs and `/app/network` are on
in production over a **bounded window** of Solana mainnet blocks: the read APIs return the
covered range, the cursor and the retained floor with every answer, so the product claims
nothing about a height outside that window. Ingestion is an operator-run CLI rather than a
continuously synchronised follower, and it is bounded for a measured reason: one block costs
6.38 MB from the RPC and 19.75 MB stored, and the indexer runs at 3.33 s per block against a
head that moves at 2.5 blocks/s, so no follower on this host can keep up
([docs/milestone-d13-network-hardening.md](docs/milestone-d13-network-hardening.md),
[docs/network-operations.md](docs/network-operations.md)). Persisted signed reputation
evidence, indexed Solana transaction reuse and an internal accounting ledger (bookkeeping
units, not $AGX) are implemented in `packages/network`; public reputation scores, $AGX
utilities and EVM privacy scoring still
require inputs the repository does not have, and the EVM chains are not indexed.

## Repository layout

This is a pnpm monorepo.

```text
apps/
  web/       Next.js frontend (landing, Wallet X-Ray, Attack My Wallet, dashboard)
  api/       Fastify API server (analysis endpoints, auth, rate limiting)
  worker/    BullMQ worker (runs the analysis pipeline)
packages/
  types/     Shared domain types
  config/    Typed environment / configuration loading
  database/  Schema migrations + repository layer
  blockchain/ RPC abstraction layer (Solana provider)
  normalizer/ Transaction parsing and normalization
  intelligence/ Signal engines (funding, counterparty, behavior, entities,
                clusters, transaction patterns, public attribution, linkability)
  scoring/   Privacy exposure scoring + confidence
  graph/     Relationship graph + Attack My Wallet path engine
  correlation/ Cross-wallet correlation (funding provenance, temporal, overlap)
  commonality/ Population commonality baselines
  monitor/   Privacy Threat Monitor pipeline + threat detection
  diff/      Analysis diffing for monitor events
  explanation/ Deterministic signal and path explanations
  webhook-delivery/ Signed webhook delivery
  queue/     BullMQ queue setup
  cache/     Redis cache layer
  logging/   Structured JSON logging + trace/privacy-safe wallet refs
infra/       Docker / deployment scaffolding
docs/        Architecture, whitepaper and design documents
tests/       Shared test fixtures and integration tests
```

Every signal an engine emits belongs to one of the categories in
[docs/signal-taxonomy.md](docs/signal-taxonomy.md), which maps them to the
seven exposure dimensions of the Privacy Exposure Score.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

See `architecture.md` for the full system architecture and the 8-day MVP build plan.

## License

Proprietary. All rights reserved.
