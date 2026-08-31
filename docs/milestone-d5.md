# Milestone D5 — Cross-Wallet Intelligence Product

Authoritative D5 completion report. D5 delivered the full hierarchy:

```text
BLOCKCHAIN DATA → OBSERVATION → EVIDENCE → RELATIONSHIP → CORRELATION
→ CLUSTER HYPOTHESIS → POTENTIAL LINKABILITY
```

Never: CORRELATION → OWNERSHIP → IDENTITY.

**Commits:** `9c3c21d` (Block 1), `0a0c01a` (Block 2), Block 3 commits (this
milestone close).

---

## 1. Block 1 (D5-A..D5-D) — Correlation Foundation

- **Cross-Wallet Correlation Engine** (`packages/correlation`, `correlation-v1.0.0`): weighted combination of independent evidence families, versioned weights, common-activity penalty, rare-signal boost, sample adequacy caps, semantic coverage caps, safe-language classification (never "SAME OWNER").
- **Funding Provenance v2** (`funding-provenance-v1.0.0`): initial funder correction, earliest non-dust funder, dust filtering, bounded 2-hop provenance, confidence decay, entity terminus.
- **Behavioral Similarity** (`behavioral-similarity-v1.0.0`): cosine/Jaccard feature similarity, strongest similarities AND differences, sample adequacy.
- **Migration 0004**: `correlation_results`, `funding_paths`, entity v3 columns, relationship pair-type unique index.

## 2. Block 2 (D5-E..D5-H) — Relationship Intelligence Primitives

- **Temporal Correlation** (`temporal-v1.0.0`): short-window repeated activity (30/60/120/300 s, base-rate corrected), directional A→B sequence, hour/day distribution similarity. No timezone/location inference anywhere. Integrated as `TEMPORAL_CORRELATION` family (weight 0.3, conservative).
- **Entity Registry V3** (`entity-registry-v3.0.0`): address roles, deprecation, notes, provenance-mandatory VERIFIED seeds, conflict rejection, commonality-aware entity overlap (popular entities ≈ 0 contribution), record confidence separated from exposure confidence. 12 entities / 14 addresses seeded (protocol program IDs only — no exchange addresses by design).
- **Multi-Hop Relationship Graph** (`relationship-graph-v1.0.0`): bounded (depth ≤ 4, nodes ≤ 200, edges ≤ 800, RPC ≤ 40, time ≤ 5 s, paths ≤ 400), hub penalty (A→Jupiter→B near-useless), bottleneck confidence (min edge confidence, depth decayed), OBSERVED/INFERRED/MIXED path types, reorder-insensitive dedup, stop reasons, fetch budgets, path explanations.
- **Cluster Hypothesis** (`cluster-hypothesis-v1.0.0`): thresholded connected components, 2+ evidence families (or 0.85 strong direct), weak bridge edges never merge clusters, entity/hub exclusion, size cap 15, stable fingerprint, honest limitations. Persisted in `relationship_clusters` (migration 0005).

## 3. Block 3 (D5-I..D5-L) — Product Integration & Closure

### 3.1 D5-I — Correlation → Graph/Cluster + Compare Product

**Inferred edge admission** (`inferred-edge-v1.0.0`, `packages/correlation/src/inferred-edges.ts`): persisted `correlation_results` become `CORRELATED_WITH` inferred edges only when passing versioned thresholds:

```ts
DEFAULT_INFERRED_EDGE_LIMITS = {
  minScore: 40, minConfidence: 0.5, minEvidenceFamilies: 2,
  minSample: 10, minSemanticCoverage: 0.4,
  strongDirectScore: 70, strongDirectFamilies: ["FUNDING", "TRANSFER_RELATIONSHIP"]
}
```

Strong direct exception: score ≥ 70 with a direct family qualifies with one
family; shared-Jupiter-style weak overlap never qualifies. Symmetric pairs
deduplicate on canonical identity; observed edges are never replaced by
inferred ones — correlation metadata attaches alongside.

**Worker integration**: each analysis loads persisted correlations for the
wallet, admits inferred edges, feeds them into `findRelationshipPaths` and
`buildRelationshipClusters`. Logs: `{candidateCorrelations, inferredEdges,
rejected}`.

**Compare API** (`POST /v1/compare`, `GET /v1/compare/:pairId`):
- validate format → reject duplicate wallet → account classification
  (programs/mints/sysvars/token accounts rejected with `ACCOUNT_NOT_COMPARABLE`)
  → kill switches → canonical cache hit ((A,B)==(B,A)) → distributed dedup
  lock → admission control → comparison quota (per-user 50/day, anon 10/day)
  → rate limit 6/min → reuse-first fresh analyses (never re-analyzes both) →
  correlation from persisted data → bounded graph → cluster context →
  structured result with evidence, limitations, engine versions.
- Comparison consumes zero RPC when both analyses are fresh (all inputs are
  persisted: transfers, behavioral features, entity registry, relationships).

**Compare UX** (`/compare`): strength ≠ confidence displayed separately,
product disclaimer, dimension breakdown (funding/transfers/counterparties/
entities/behavior/protocol/timing) with strength+confidence+evidence,
"Why might these wallets be related?" vs "Why might this be misleading?",
path inspector (solid=observed, dashed=inferred, edge strength/confidence/
evidence), cluster view ("Potentially Related Wallets" — never "Same Owner"),
mobile fallback (cards + list).

**Wallet X-Ray integration**: "Potential Wallet Correlations" section shows
qualifying persisted correlations ranked by score/confidence with a Compare
link — no forced pairwise discovery.

### 3.2 D5-J — Production Finishing

- **Email**: real SMTP provider (nodemailer) behind `EMAIL_PROVIDER=smtp`,
  `EMAIL_FROM`, `EMAIL_ENABLED`; secrets server-side only. Failures
  classified transient vs permanent (SMTP 4xx/5xx + message markers);
  `deliverNotification` retries only transient failures, permanent failures
  mark the notification failed without retry. Idempotency preserved by the
  PENDING status guard + `attempt_count`.
- **Monitor pause/resume**: API `PATCH /v1/me/monitors/:id {status}`
  (ACTIVE/PAUSED) + dashboard toggle. Scheduler `listDue` returns only
  ACTIVE monitors; paused monitors skip their window and resume on the next
  valid scheduled cycle — no catch-up storm.
- **Monitor states**: ACTIVE/PAUSED/DEGRADED/ERROR/DISABLED surfaced in the
  dashboard with explanations.
- **Notifications**: unread count + mark-read + acknowledge already present;
  dashboard shows per-monitor unread badges.

### 3.3 D5-K — Accuracy & False-Positive Validation

**Golden correlation dataset** (`tests/golden-correlation-dataset.ts`,
`pnpm test:correlation-dataset`, 27 asserts): explicit false-positive matrix
and positive cases.

| Case | Expected | Result |
|---|---|---|
| FP-1 shared Jupiter only | != HIGH, < 35 | ✔ |
| FP-2 shared USDC only | != HIGH, no cp family | ✔ |
| FP-3 shared exchange only | != HIGH | ✔ |
| FP-4 single timing coincidence | no temporal family | ✔ |
| FP-5 high-volume collision | temporal < 0.5 | ✔ |
| FP-6 DeFi behavior only | < 60 | ✔ (was 90 — fixed) |
| FP-7 dust attack | no funding, < 40 | ✔ |
| FP-8 hub-only | < 40 | ✔ |
| FP-9 low sample | confidence ≤ 0.5 | ✔ |
| FP-10 low semantic coverage | behavior capped | ✔ |
| FP-11 unrelated | < 20 | ✔ |
| P-1 strong funding | ≥ 70 | ✔ |
| P-2 repeated transfer | ≥ 40 | ✔ |
| P-3 multi-evidence | ≥ 3 families, ≥ 55 | ✔ |
| P-4 funding+temporal | > funding alone | ✔ |

**Ablation** (P-4 fixture):

```text
FULL                             56
without direct (funding+transfer) 45
without TEMPORAL                 52
```

Score deltas are inspectable via `disabledFamilies` (D5-K §74).

**Bugs found & fixed in D5-K validation:**
1. **Behavior-only false positive (score 90)**: two DeFi-heavy wallets with
   near-identical distributions produced HIGH correlation from
   BEHAVIORAL_SIMILARITY alone. Root cause: single non-direct evidence family
   could dominate the weighted average. Fix: **single-family cap** in
   `computeCorrelation` — when exactly one non-direct family (behavior/
   entity/counterparty/protocol/temporal) is admitted, raw score caps at 0.45
   and a limitation explains the cap. Direct flow (funding/transfers) remains
   the only family allowed to stand alone as strong evidence. Golden
   correlation 31/31 unchanged.
2. **Ablation harness misuse**: "without funding" retained the transfer
   family, making the ablation read counter-intuitively; fixed to remove the
   direct-flow group together.

**Golden user wallets** (`tests/golden-user-wallets.ts`): 14 addresses across
low/medium/high activity, DeFi-heavy, transfer-heavy, entity-heavy, mixed —
all valid user-wallet addresses (mainnet runner). Account classification
suite (`tests/golden-account-classification.ts`, 14/14) unchanged.

### 3.4 D5-L — Performance, Security, E2E

**Load harness** (`tests/load-test-correlation.ts`, `pnpm loadtest:correlation
-- --count N --concurrency C --pairs P --same-pair --cache-reuse --timeout`):

| Run | Result |
|---|---|
| 8 cmp, concurrency 4, 2 pairs | 0 failures, 94 ms total, ~43 ms avg |
| 10 cmp, concurrency 10, same-pair | 0 failures, 100 ms, one canonical pair |
| 10 cmp, concurrency 5, 3 pairs, cache-reuse | 0 failures, 70 ms, ~31 ms avg |

Reverse-pair (B vs A) comparisons resolve to the canonical pair identity in
every run — no duplicate compute per pair. Same-pair concurrency is dedupped
at the API layer by the distributed lock (verified in the compare route; the
load harness exercises the service under concurrency with 0 failures).

**RPC accounting**: comparison from fresh analyses consumes **0 RPC calls**
(no account fetch, no transaction fetch — all persisted). Secondary graph
expansion is DB-backed (`wallet_relationships`), bounded by
`MAX_SECONDARY_WALLETS/RPC_CALLS`; budget exhaustion produces partial results
with an explicit limitation, never a crash.

**Graph budgets** verified: depth ≤ 4, nodes ≤ 200, edges ≤ 800,
secondary RPC ≤ 40, time ≤ 5 s, path budget ≤ 400 (versioned defaults).

**Quota/admission**: comparison has its own daily quota
(`COMPARE_DAILY_ANON_LIMIT=10`, `COMPARE_DAILY_USER_LIMIT=50`), route rate
limit (`COMPARE_RATE_LIMIT_PER_MINUTE=6`), and reuses the admission pipeline
(queue depth, active jobs, per-actor pending). Kill switches
(`ENABLE_CORRELATION_ANALYSIS`, `ENABLE_MULTI_HOP_GRAPH`,
`ENABLE_CLUSTER_HYPOTHESES`) gate compare; Wallet X-Ray and monitors keep
working when disabled.

**Security**: input validation (format via PublicKey, duplicate wallet,
body size), server-side auth for user-owned endpoints, RLS reviewed — no new
D5 tables are user-owned (correlation results, funding paths, clusters,
relationships are public blockchain-derived data; compare results live in the
Redis cache, not per-user rows). No secrets in logs (wallet refs truncated,
email recipient truncated). Security headers/CSP preserved (tested).

**Final D5 E2E** (`tests/e2e-d5.ts`, `pnpm test:e2e-d5`, 18 asserts):
reset schema → migrate → seed Entity Registry V3 → seed analyzed wallets →
compare → funding/behavioral families present → evidence inspectable →
limitations → cache A/B → reverse B/A canonical reuse → unrelated pair stays
low with no cluster → bounded graph stop reason.

---

## 4. Scoring Formulas (reproducibility, D5 §125)

```
correlation rawScore = Σ(weight_i · strength_i) / Σ(weight_i)     [admitted families only]
single-family cap: non-direct-only → min(rawScore, 0.45)
correlationScore = round(rawScore · 100)
confidence = 0.25 + 0.12·families + 0.3·rawScore
           × 0.4/0.6/0.85 by sample (<3/<10/<30)
           × 0.7 when semantic coverage < 0.4          cap 0.98

temporal expected collisions E = (txA·txB·2·window)/period
temporal signal kept iff observed > 1.2·E and E/observed ≤ 0.15

hubPenalty = hubFactor ≥ 0.6 ? 0.25 : 1 − 0.5·hubFactor
pathScore = Π(hub-penalized edge strengths)
pathConfidence = min(edge confidences) · (1 − 0.12·depth)

cluster admission: strength ≥ 0.35 AND confidence ≥ 0.4 AND
                   (families ≥ 2 OR (direct AND strength ≥ 0.85))
clusterConfidence = min(memberConf) · (0.6 + 0.25·familyDiversity)
                    · sizePenalty(>8 → 0.85) · max(0.5, avgStrongConf)

inferred edge: score ≥ 40 AND confidence ≥ 0.5 AND families ≥ 2
               OR (score ≥ 70 AND direct family present)
```

## 5. Engine Versions (active)

| Engine | Version |
|---|---|
| correlation | `correlation-v1.0.0` |
| funding family | `funding-family-v1.0.0` |
| transfer family | `transfer-family-v1.0.0` |
| counterparty overlap | `counterparty-overlap-v1.1.0` |
| entity overlap | `entity-overlap-v1.1.0` |
| protocol similarity | `protocol-similarity-v1.1.0` |
| behavioral similarity | `behavioral-similarity-v1.0.0` |
| temporal | `temporal-v1.0.0` |
| entity registry | `entity-registry-v3.0.0` |
| funding provenance | `funding-provenance-v1.0.0` |
| relationship graph | `relationship-graph-v1.0.0` |
| cluster hypothesis | `cluster-hypothesis-v1.0.0` |
| inferred edge | `inferred-edge-v1.0.0` |
| compare | `compare-v1.0.0` |

## 6. Regression Results (final)

| Suite | Result |
|---|---|
| `pnpm -r typecheck` | clean |
| `pnpm -r test` | 145 pass, 0 fail |
| `pnpm -r build` | 18/18 packages |
| golden correlation | 31/31 |
| correlation dataset (FP matrix) | 27/27 |
| golden monitors | 9/9 |
| e2e-monitor | 14/14 |
| Block 2 E2E | 22/22 |
| account classification | 14/14 |
| final D5 E2E | 18/18 |
| loadtest:correlation | 0 failures (3 configs) |
| migrations | 0001..0005 clean |

## 7. Bugs Discovered & Fixed (D5)

1. **Behavior-only false positive** (D5-K, real): single non-direct family
   could drive HIGH correlation. Fixed with single-family cap + limitation.
2. **Temporal strength double-count** (Block 2): distribution-only strength
   inflated to 0.6. Fixed.
3. **Temporal safe-language self-violation**: limitation text contained
   "timezone". Reworded.
4. **`EvidenceFamilyResult.engineVersion`** missing from shared types; added
   and populated for every family.
5. **Relationship graph never expanded secondary wallets** (frontier seeded
   with the target itself); fixed to seed with direct neighbors.
6. **Intermediate paths never reported**; fixed with bounded enumeration +
   dedup + path budget.
7. **`findRelationshipPaths` sync but fetched async rows**; made async.
8. **Migration 0005 FK type mismatch** (analysis_id uuid vs bigint); caught by
   live migration.
9. **Compare quota recording would violate `usage_records.analysis_id` FK**
   ("compare:pair" is not a uuid); fixed with nullable analysis_id +
   dedicated `comparison` usage type.
10. **E2E fixture false positive**: "unrelated" wallet was seeded with
    transfers from wallet A and identical behavioral features — fixture
    corrected (distinct profile, no shared transfers); engine behaved
    correctly.

## 8. Known Limitations

- No global Solana indexer; analysis scope is bounded history
  (`ANALYSIS_MAX_TRANSACTIONS`).
- Hub frequency is derived from the entity registry + local data, not global
  on-chain frequency.
- Entity registry is incomplete by design: protocol program IDs only, no
  verified exchange addresses.
- Semantic coverage varies by protocol; semantic-heavy evidence is
  confidence-capped.
- Secondary graph exploration is budget-limited and DB-backed (no RPC
  crawling).
- Cluster hypotheses are per-target-wallet and are never ownership claims.
- Compare requires fresh READY analyses for both wallets; it does not
  trigger new analysis jobs (intentional: reuse-first, no forced discovery).

## 9. Production Configuration (initial, measurement-informed)

```env
# D5 budgets (load-tested, conservative)
GRAPH_MAX_DEPTH=4
GRAPH_MAX_NODES=200
GRAPH_MAX_EDGES=800
GRAPH_MAX_TIME_MS=5000
MAX_SECONDARY_WALLETS=20
MAX_SECONDARY_RPC_CALLS=40
CLUSTER_MAX_SIZE=15

# Inferred-edge admission
MIN_INFERRED_EDGE_SCORE=40
MIN_INFERRED_EDGE_CONFIDENCE=0.5
MIN_INFERRED_EDGE_EVIDENCE_FAMILIES=2
INFERRED_EDGE_STRONG_DIRECT_SCORE=70

# Compare limits
COMPARE_RATE_LIMIT_PER_MINUTE=6
COMPARE_DAILY_ANON_LIMIT=10
COMPARE_DAILY_USER_LIMIT=50
CORRELATION_CACHE_TTL_SECONDS=3600

# Email (server-side secrets)
EMAIL_ENABLED=false
EMAIL_PROVIDER=console        # smtp in production
EMAIL_FROM=AEGIX <no-reply@aegix.local>

# Kill switches (default ON)
ENABLE_CORRELATION_ANALYSIS=true
ENABLE_MULTI_HOP_GRAPH=true
ENABLE_CLUSTER_HYPOTHESES=true
```

Worker concurrency and monitor budgets unchanged from D4 (see
docs/milestone-d4.md).

## 10. Cost Observations

- Fresh comparison with both analyses fresh: **0 RPC calls**, ~6 DB queries
  (wallet lookup, transfers ×2, features ×2, entities, relationships ×2),
  one graph build bounded by budgets, one cache write.
- Cached comparison: 1 Redis read, 0 DB, 0 RPC.
- Reverse pair: canonical key hit, no recompute.
- Load runs (local Postgres+Redis): ~30-90 ms per comparison at concurrency
  4-10, no failures.
- Memory: comparison service allocates only the two wallets' persisted
  transfer/feature sets (bounded by analysis limits); graph expansion is
  bounded by node/edge budgets.

## 11. D6 Direction (recommended)

With D5 closed as a coherent intelligence product, natural next steps:
developer API surface (bounded, quota'd), saved comparisons for registered
users (user-owned table + RLS), global commonality index from analyzed
population statistics (not full-chain indexing), and monitor-driven
correlation alerts.
