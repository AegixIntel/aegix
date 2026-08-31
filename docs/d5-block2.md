# D5 Block 2 — Temporal Correlation, Entity Registry V3, Multi-Hop Relationship Intelligence, Cluster Hypothesis

Working engineering report for **D5-E .. D5-H** (docs/milestone-d5.md is NOT
finalized; the final D5 report belongs after D5-I..L, per the block brief §89).

Scope: D5-E temporal engine, D5-F entity registry v3 completion, D5-G bounded
multi-hop relationship graph, D5-H conservative cluster hypotheses. Block 1
(D5-A..D5-D) is preserved — no working engine was rewritten.

---

## 1. Temporal Engine (D5-E)

**File:** `packages/correlation/src/dimensions/temporal.ts` (+ `temporal.test.ts`,
integrated into `computeCorrelation` as `TEMPORAL_CORRELATION` family).
**Version:** `temporal-v1.0.0`.

### Signals implemented (only those supported by available data, §5)

| Signal | Implementation | Evidence output |
|---|---|---|
| `REPEATED_SHORT_WINDOW_ACTIVITY` | A/B activity within 30/60/120/300 s windows, repeated ≥2 (`TEMPORAL_MIN_REPEATED_MATCHES`) | matched windows with A/B signatures, timestamps, Δ seconds (§16) |
| `SEQUENTIAL_ACTIVITY_PATTERN` | A → B within 120 s (`TEMPORAL_SEQUENCE_WINDOW_SECONDS`), repeated | count of directional repeats (direction retained, §12) |
| `ACTIVE_HOUR_SIMILARITY` / `ACTIVE_DAY_SIMILARITY` | normalized distribution cosine (UTC buckets) | hour/day similarity values |
| `CORRELATED_ACTIVITY_BURSTS` | short-window matches across multiple windows | window selection |

No timezone/country/location inference anywhere (§6): the output describes
"activity timing patterns", and the limitation text explicitly states that
timing never indicates where or when a person lives.

### Formulas

```
expected random collisions  E = (txA · txB · 2·window) / observationPeriod
signal kept only when        observed > 1.2·E        (above random expectation)
                             E/observed ≤ 0.15       (TEMPORAL_MAX_COLLISION_RATIO)
short-window strength        min(0.8, 0.25 + min(1, excess/5)·0.4 + min(1, n/8)·0.15)
distribution strength        hourSim·0.6 + daySim·0.4   (capped contribution)
combined strength            bestWindowStrength + distContribution + directional·0.1
confidence                   0.25 + repetition + dist + directional, ×0.6 sample<10, ×0.6 dq<0.4, cap 0.85
```

**Base-rate correction (§9-§10):** high-volume wallets naturally collide; the
expected-collision formula and the collision-ratio guard keep 10k-tx wallets
from correlating with everyone. The `TEMPORAL_MAX_COLLISION_RATIO` test
(200 txs × 2 wallets, deterministic offsets) confirms no high correlation.

**Volume normalization:** distribution similarity is per-wallet normalized
probability vectors; short-window signal is base-rate corrected.

### Bugs found & fixed during this block

1. **Strength double-count** (`temporal.ts`): distribution-only case computed
   `distContribution` twice (`max(...) + distContribution + directional*0.1`),
   inflating same-active-hours-only strength to ~0.6. Fixed to a single
   bounded contribution — the "same active hours only" negative control now
   stays weak (§14).
2. **Safe-language self-violation**: the limitation string literally contained
   the word "timezone", which the safe-language test scans for. Reworded.
3. Found in the pre-existing temporal work: `engineVersion` was set on
   `EvidenceFamilyResult` but the shared type lacked the field — added to
   `@aegix/types` and to every family (funding, transfer, counterparty,
   entity, protocol, behavioral) for per-family version traceability (§73).

### Temporal tests (8, all deterministic)

`repeated 45s window → moderate`, `single coincidence → null`, `high-volume
unrelated → weak`, `same active hours only → weak`, `directional A→B repeated`,
`low sample caps confidence`, `low data quality caps confidence`, `safe
language`. All pass; the high-volume and same-hours controls never produce
HIGH correlation (§14-§15).

---

## 2. Entity Registry V3 Completion (D5-F)

**Files:** `packages/database/src/seed-entities.ts`,
`packages/database/src/repositories/entity-registry.ts`,
`packages/types/src/entity.ts`, `packages/correlation/src/dimensions/overlap.ts`
(+ `entity-overlap.test.ts`). Migration 0004 already carried the schema
columns; **no duplicate columns were added** (§19).

### Schema audit result

Migration 0004 already provides `entity_addresses.address_role`,
`deprecated_at`, `notes` and `analysis_jobs.registry_version`. The repo now
reads/writes them, and the shared `Entity`/`EntityAddress` types express:
entity id, canonical name, entity type, protocol (via entity name + label),
address, address role, source, verification status, confidence, first/last
verified, deprecation status, notes (§20). All present in the actual table —
verified via `information_schema` and a live seed run (`seeded 12 entities,
14 addresses`).

### Entity types

Existing union extended with the categories the seeds actually use:
`LENDING`, `NFT_MARKETPLACE`, `STAKING`, `INFRASTRUCTURE` (DEX/BRIDGE/
PROTOCOL/SERVICE/etc. already existed). No unused category values were added
beyond these (§21).

### Address roles

`PROGRAM | ROUTER | TREASURY | VAULT | HOT_WALLET | DEPOSIT | ESCROW |
UNKNOWN_ROLE` — typed in `@aegix/types`, persisted via `address_role`
(default `UNKNOWN_ROLE`, only assigned when supported, §22).

### Verified-only seeding (§23-§24)

`validateSeedEntries` now rejects:
- VERIFIED address **without evidence source** (provenance mandatory)
- invalid Solana addresses (base58 + length)
- duplicate conflicting address claims across entities
- invalid roles, invalid statuses, out-of-range confidence
- **deprecated + VERIFIED conflict** (a deprecated address must not be VERIFIED)

Exchange deposit addresses, forum guesses, community tags: still **absent** —
no verified exchange seeds exist (12 entities, all protocol program IDs with
documented sources).

### Conflict model (§25)

A duplicate address claimed by two different entities fails validation
("claimed by both …") — never silently resolved. The repo additionally exposes
`findConflictingAddress` for runtime checks.

### Deprecation (§26)

`deprecatedReason` on a seed address → persisted as `DEPRECATED` status +
`deprecated_at` + notes; `findAddressesByChain` excludes deprecated
addresses. Deprecated addresses remain in the table for reproducibility.

### Registry versioning (§27, §73)

`ENTITY_REGISTRY_VERSION = "entity-registry-v3.0.0"` exported from the repo;
`analysis_jobs.registry_version` (migration 0004) is the persistence hook.

### Entity overlap improvements (§29-§30)

`evaluateEntityOverlap` now takes `entityNamesByAddress` +
`entityConfidenceByAddress` and:
- **commonality penalty**: `COMMON_ENTITIES` (Jupiter, Raydium AMM, Pump.fun,
  Wormhole, Orca, Meteora, Marinade, Metaplex) contribute a flat 0.05 —
  below the family `minimumStrength` — so "both used Jupiter" adds nothing.
  Shared Jupiter-only scores 0.01-0.05 (test: `strength < 0.15`).
- **uncommon verified entity**: 0.25 + 0.25·repetition (up to 0.5), so
  "both repeatedly interact with the same uncommon verified entity" is
  materially stronger (test: `repeated > single`, ≥ 0.25 for repeated).
- **record confidence separation (§28)**: family confidence is scaled by
  `min(entityConfidenceByAddress)` — a 0.4-confidence record caps the family,
  independent of wallet exposure confidence.

### Entity tests

`packages/database/src/seed-entities.test.ts` (7, extended semantics kept
green) + `packages/correlation/src/entity-overlap.test.ts` (5 new): valid
seed, invalid address, missing provenance, conflict, deprecated-conflict,
common-entity penalty, uncommon-entity strength, record-confidence
separation, safe language.

---

## 3. Multi-Hop Relationship Intelligence (D5-G)

**File:** `packages/graph/src/relationship-graph.ts` (+
`relationship-graph.test.ts`). **Version:** `relationship-graph-v1.0.0`.

### Bounded graph config (§33)

```ts
DEFAULT_RELATIONSHIP_GRAPH_LIMITS = {
  maxDepth: 4, maxNodes: 200, maxEdges: 800,
  maxCounterpartiesPerNode: 30, minEdgeStrength: 0.2,
  maxSecondaryWallets: 20, maxSecondaryRpcCalls: 40,
  maxGraphTimeMs: 5000, hubPenaltyThreshold: 0.6, maxPaths: 400
}
```

All versioned in the engine; worker config mirrors them
(`GRAPH_MAX_DEPTH/NODES/EDGES/TIME_MS`, `MAX_SECONDARY_WALLETS/RPC_CALLS`,
`CLUSTER_MAX_SIZE`). No unbounded defaults (§33, §77). Depth semantics:
`maxDepth` = max hops; 2-hop paths are found before any 3-hop expansion
(expansion is frontier-based, depth-ordered) (§34).

### Edge model (§35-§36)

Every edge carries: type, direction, strength, confidence, observation class
(`OBSERVED`/`INFERRED`), evidence references, source engine, engine version.
Direct/observed types: `FUNDED`, `TRANSFERRED`, `RECEIVED_FROM`,
`REPEATED_COUNTERPARTY`. Inferred types: `SHARED_COUNTERPARTY`,
`SHARED_ENTITY`, `BEHAVIORALLY_CORRELATED`, `TEMPORALLY_CORRELATED` (new
shared types in `@aegix/types`).

### Hub penalty (§37-§38)

`hubPenalty = nodeHub ≥ threshold ? 0.25 : 1 − nodeHub·0.5`. Node commonality
comes from the entity registry (verified entities are common by definition)
and from caller-provided `commonality` map. **A→Jupiter→B with two 0.9 edges
scores < 0.3** (verified by test and by the Block 2 E2E).

### Path scoring & confidence (§39-§41)

```
pathScore      = Π(hub-penalized edge strengths)
pathConfidence = min(edge confidences) · (1 − 0.12·depth)
```

Bottleneck: a path with edge confidences [0.95, 0.91, 0.42] is capped by the
0.42 edge (test asserts `confidenceScore ≤ 0.42`). Never an average.

### Path classification & diversity (§42-§44)

`OBSERVED_PATH | INFERRED_PATH | MIXED_PATH`; identity is a canonical
(sorted node set + sorted typed edge set) hash — reorder-insensitive
(A→B ≡ B→A, tested), and duplicate semantic paths are merged (stronger
variant wins). Path budget `maxPaths` prevents enumeration blow-up.

### Secondary fetch policy & budgets (§45-§46)

Expansion consumes **persisted relationships only** (`wallet_relationships`
table, DB-backed) — the worker passes a `fetchRelationships` bound to
`relationshipRepo.listForWallet`, never RPC. Every run exposes
`secondaryWalletsFetched`, `rpcCallsConsumed`, `rpcBudgetRemaining`.

### Stop reasons (§47)

`MAX_DEPTH | MAX_NODES | MAX_EDGES | RPC_BUDGET | TIME_BUDGET | PATH_BUDGET |
LOW_EDGE_STRENGTH | NO_NEW_RELATIONSHIPS` — recorded on every run.

### Path explanation (§48)

Each path carries `explanation[]`: observed vs inferred counts, hub warnings,
weakest-edge confidence note, weak-edge flags, entity-terminus note, and the
safe-language footer ("Relationship paths describe observable linkability,
never ownership").

### Graph tests (§49, 11 new)

direct funding path; 2-hop bottleneck confidence; hub-only near-useless; dust
path weak; mixed observed/inferred → MIXED_PATH; long weak path penalized;
budget exhaustion (RPC budget respected); path dedup; reorder-insensitive
identity; classifyPathType; safe language.

---

## 4. Cluster Hypothesis Engine (D5-H)

**File:** `packages/graph/src/cluster.ts` (+ `cluster.test.ts`).
**Version:** `cluster-hypothesis-v1.0.0`. Always a **RelationshipCluster** —
never an OwnerCluster (§50).

### Algorithm (§54)

Thresholded connected components: BFS from the target wallet over admitted
edges, deterministic, no ML/community-detection libraries.

### Admission thresholds (§52-§53)

```ts
DEFAULT_CLUSTER_LIMITS = {
  minEdgeStrength: 0.35, minConfidence: 0.4,
  minEvidenceFamilies: 2, strongDirectEdgeStrength: 0.85,
  bridgeEdgeMaxStrength: 0.4, maxClusterSize: 15
}
```

An edge admits when `strength ≥ 0.35 AND confidence ≥ 0.4 AND
(evidenceFamilies ≥ 2 OR (direct AND strength ≥ 0.85))`. One weak shared
protocol never admits; the Block 2 E2E and unit tests confirm shared-Jupiter-
only and single-weak-edge cases produce **zero clusters**.

### Bridge-edge problem (§55)

Weak inter-cluster edges are excluded at admission (strength/confidence/
multi-evidence gates), so one weak bridge cannot merge two strong clusters.
Test: strong T→W1 (0.8, 2 families) + weak W1→W2 (0.3, 1 family) → cluster
contains only W1; the bridge edge is reported in `rejectedEdges`.

### Cluster confidence (§56)

```
conf = weakestMemberConfidence · (0.6 + 0.25·familyDiversity)
       · sizePenalty(>8 members → 0.85) · max(0.5, avgStrongConfidence)
cap 0.9, floor 0.05
```

Bottleneck-dominant; low-data members get `×0.6` and are flagged (§58-§59).

### Member output, core, limitations (§57-§59)

Members carry wallet, strength-to-core (anchor = target wallet, graph-structure
based, never called "main owner"), confidence, evidence families, low-data
flag. Limitations output weak members, low-data members, hub influence,
inferred-only notes, and the standing safe-language footer.

### Size cap & hub isolation (§60-§62)

`maxClusterSize` bounds members; `entityAddresses` (from the registry) are
excluded from membership entirely — entities support relationships but never
count as correlated wallet members.

### Fingerprint & persistence (§63-§64, §87)

`cluster-<sha256(target|sortedMembers|sortedFamilies)[0:12]>` — stable,
deterministic, reorder-insensitive. Persisted in the new
`relationship_clusters` table (migration `0005_d5_block2_clusters.sql`:
analysis_id uuid FK, wallet_id FK, cluster_id, members jsonb, confidence,
evidence_families, limitations, engine_version, unique(analysis_id,
cluster_id)). Repo `upsert` is idempotent — verified live: double upsert of
the same cluster → 1 row.

### Cluster tests (§66-§67, §81, 10 new)

strong multi-evidence cluster; weak single-edge → no cluster; shared-Jupiter →
no cluster; bridge-edge separation; strong-direct exception; entity/hub
exclusion; low-data member cap; size cap; stable fingerprint; safe language.

---

## 5. Block 2 Integration & Pipeline

**`tests/e2e-correlation-block2.ts`** (`pnpm test:correlation-block2`, 22
asserts, offline): Wallet A/B normalized activity → temporal correlation →
entity matching → correlation engine (temporal family present, funding
dominates) → multi-hop graph (bounded, budget accounting, stop reason, hub
penalty) → cluster hypothesis (multi-evidence membership, negative control) →
persisted structured result with engine versions everywhere and safe language
end-to-end.

**Worker integration** (`apps/worker/src/processors/analysis.ts`, gated by
`ENABLE_CORRELATION_ANALYSIS`, best-effort): after funding provenance, the
pipeline runs `findRelationshipPaths` (persisted relationships + DB-backed
bounded expansion) and `buildRelationshipClusters`, persists paths via
`insertPaths` and clusters via the new repo (`replaceForAnalysis` — re-runs
replace, never duplicate), with structured logs:
`{durationMs, paths, nodes, edges, stopReason, secondaryFetched, rpcConsumed,
clusters, clusterMembers}` (§75). Metrics (§76) are emitted through the
existing structured log pipeline; no separate metrics server exists in this
repo.

## 6. Fixture Cleanup (§85)

`tests/golden-wallets.ts` split:
- **`tests/golden-user-wallets.ts`** (`pnpm test:user-wallets`): user-wallet
  analyses only (new wallet + repeated-counterparty wallet).
- **`tests/golden-account-classification.ts`** (`pnpm test:account-classification`,
  **14/14, offline**): asserts the D3 classifier rejects program IDs, mints,
  sysvars with synthetic account-info fixtures — no network required, no
  classifier weakening.

The old runner is kept (deprecated header) for reproducibility; `test:wallets`
now points at the user-wallet runner.

## 7. Regression Results

| Suite | Result |
|---|---|
| `pnpm -r typecheck` | clean |
| `pnpm -r test` | 115 tests, 0 fail (correlation 28, graph 25, database 7, blockchain 13, intelligence 5, normalizer 11, scoring 8, diff 11, explanation 3, logging 4) |
| `pnpm -r build` | 18/18 packages |
| golden correlation | **31/31** |
| golden monitors | **9/9** |
| e2e-monitor | **14/14** |
| Block 2 E2E | **22/22** |
| account classification | **14/14** |
| migrations | 0001..0005 applied cleanly |
| entity seed | 12 entities / 14 addresses (provenance + roles) |

No golden values changed (31/31) — the temporal family weight was already
conservative (0.3, minimumStrength 0.3) and Block 1 behavior is preserved.

## 8. Bugs Discovered & Fixed

1. Temporal strength double-count (distribution-only inflated to 0.6).
2. Temporal safe-language self-violation ("timezone" in limitation text).
3. `EvidenceFamilyResult.engineVersion` missing from shared types — added and
   populated for all families.
4. Relationship-graph expansion never expanded secondary wallets (frontier
   seeded with the target itself); fixed to seed with direct neighbors — the
   budget-exhaustion test now exercises real fetches.
5. 2-hop/intermediate paths were never reported (only terminus/depth-0);
   fixed to report all bounded paths with dedup + path budget.
6. `findRelationshipPaths` was sync but fetched async rows; made async.
7. Migration 0005 FK type mismatch (analysis_id uuid vs bigint) — caught by
   live migration run before any data was written.

## 9. Known Limitations

- **Temporal**: only UTC-based distribution comparison (deliberate — no
  timezone inference); sequence direction is A→B only for the target pair;
  burst detection is window-count based, not spectral.
- **Entity registry**: only protocol program IDs are seeded; no verified
  exchange addresses exist (by design, §24). `COMMON_ENTITIES` is name-based;
  entity categories are not yet factored into the penalty.
- **Graph**: hub commonality currently derives from the registry + caller
  map, not from global counterparty frequency across the analyzed population
  (local degree is available but deliberately not used to avoid pretending to
  have global degree, §38). Expansion is DB-backed only — no RPC secondary
  fetch is wired yet, so `rpcCallsConsumed` counts DB fetches.
- **Cluster**: clusters are per-target-wallet (star topology from the target);
  global community detection across all analyzed wallets is out of scope.
  Inferred (correlation) edges are not yet fed from the correlation engine
  into the worker's cluster input — only observed edges (funding/transfer)
  currently drive cluster membership.
- Confidence formulas are heuristic; they will be calibrated with the D5-K/L
  false-positive and load validation passes.

## 10. Recommended Block 3 Starting Point (D5-I)

Wire the **correlation engine output into the graph/cluster pipeline**:
persist cross-wallet correlation results (already in `correlation_results`),
then feed TEMPORAL/BEHAVIORAL/SHARED_ENTITY correlations as inferred edges
into `findRelationshipPaths` and `buildRelationshipClusters`, and surface
paths/clusters in the wallet x-ray UI with the safe-language vocabulary from
this block.
