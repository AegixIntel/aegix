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
  BTC, ETH and SOL market data and tokenized stocks read from Solana; news volume by
  topic and delayed options activity are built but not captured in production
  (`docs/milestone-d14-rewind-discovery.md`). Narrative Radar, Signal Engine and
  Cross-Market Intelligence (first engines, default off;
  `docs/milestone-d15-market-intelligence-engines.md`), and the AI Intelligence
  Copilot (default off, needs an LLM provider; `docs/milestone-d16-ai-copilot.md`).
  There is still no licensed market data source.
- **In development:** Anomaly Detection — capturing since 8 October 2026; its first
  engine version was replaced the same day and the corrected one has no record yet.
- **Planned:** Wallet Reputation, $AEX economic layer,
  multi-chain. **Research:** Intelligence Network.

### Network ingestion

Finalized-block ingestion for Solana, Ethereum and Base, the wallet history read APIs and
`/app/network`, persisted signed reputation evidence, indexed Solana transaction reuse and
internal $AEX accounting are implemented in `packages/network`. They are not deployed
infrastructure: network reads are off by default (`ENABLE_NETWORK_API=false`), ingestion is
an operator-run CLI rather than a continuously synchronised indexer, and an 85-minute live
run fell behind mainnet without recovering on a free endpoint
([docs/milestone-d13-network-hardening.md](docs/milestone-d13-network-hardening.md)).
Public reputation scores, an issued token and EVM privacy scoring still require inputs the
repository does not have. See [setup and operator commands](docs/network-operations.md).

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
