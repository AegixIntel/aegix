# AEGIX — On-Chain Privacy Intelligence

AEGIX is an on-chain privacy intelligence platform that helps wallet owners understand what publicly observable blockchain activity may reveal about them.

**Primary chain:** Solana
**Live products:** Wallet X-Ray, Attack My Wallet, Compare Intelligence, Privacy Threat Monitor, Developer Intelligence API
**Planned:** Market Intelligence, AI Copilot, Wallet Reputation API, $AEX economic layer, multi-chain — see [docs/whitepaper.md](docs/whitepaper.md)
**Primary principle:** *See What Others Don't.*

**Network intelligence:** continuous finalized ingestion for Solana/Ethereum/Base,
wallet history APIs and `/app/network`, persisted signed reputation evidence, indexed
Solana transaction reuse, and internal $AEX accounting are implemented. Public reputation
scores, an issued token and EVM privacy scoring still require further inputs/work.
See [setup and operator commands](docs/network-operations.md).
**Privacy pillar principle:** *Know What the Blockchain Knows.*

> AEGIX must be able to explain why it believes a wallet is exposed. It never returns an unexplained score.

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
