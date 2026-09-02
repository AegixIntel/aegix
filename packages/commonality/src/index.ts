/**
 * Population Commonality Index (D6-G), see docs/d6-block2.md.
 *
 * Empirical frequency statistics over the AEGIX-ANALYZED population —
 * NOT the full Solana blockchain (§79). Aggregation is worker-triggered,
 * incremental and idempotent per (wallet, version): a wallet's latest
 * analysis REPLACES its previous contribution (snapshot semantics), so
 * re-analysis never double-counts (§93-§95).
 *
 * The commonality penalty is a smooth bounded function (no binary cliff,
 * §87): rare observations → near-zero penalty; very common → high penalty.
 */

import type { Sql } from "@aegix/database";
import {
  createPopulationCommonalityRepo,
  createWalletAnalyticsRepo,
  type PopulationObservationType
} from "@aegix/database";

export const POPULATION_COMMONALITY_ENGINE_VERSION = "population-commonality-v1.0.0";

export interface CommonalityContext {
  sql: Sql;
}

export interface CommonalityForAddress {
  /** Distinct analyzed wallets that observed this address. */
  distinctWallets: number;
  /** Total observations across the analyzed population. */
  observationCount: number;
  /** Distinct analyzed wallets contributing to the version. */
  populationSize: number;
  /** distinctWallets / populationSize (0 when population is 0). */
  frequency: number;
  /** populationSize >= COMMONALITY_MIN_POPULATION. */
  sampleAdequate: boolean;
}

/**
 * Smooth commonality penalty in [0, 1]: how much shared evidence involving
 * this key should be discounted. penalty = 0 when the observation is rare
 * (below the rarity floor), rising smoothly to a cap of 0.9 for keys seen
 * by ~all of the population. The floor protects small populations from
 * overstating commonality (§84, §87).
 */
export function commonalityPenalty(frequency: number, populationSize: number, minPopulation: number): number {
  if (populationSize < minPopulation || populationSize <= 0) return 0;
  const f = Math.min(1, Math.max(0, frequency));
  // Rare (seen by < 5% of the population): no penalty.
  if (f < 0.05) return 0;
  // Smooth logistic-ish ramp from 0.05 → 1.0 frequency, capped at 0.9.
  const t = (f - 0.05) / 0.95; // 0..1
  const penalty = 0.9 * (t * t * (3 - 2 * t)); // smoothstep
  return Math.round(penalty * 100) / 100;
}

/**
 * Aggregates one wallet's contribution into the population index.
 * Idempotent: re-running with the same analysis is a no-op; a newer
 * analysis replaces the wallet's previous contribution (snapshot
 * semantics). Bounded batch (§92): only the wallet's own normalized
 * observations are scanned.
 */
export async function aggregatePopulation(ctx: CommonalityContext, input: { walletId: string; analysisId: string; version?: string; maxObservations?: number }): Promise<{ populationSize: number; observations: number }> {
  const { sql } = ctx;
  const version = input.version ?? POPULATION_COMMONALITY_ENGINE_VERSION;
  const analyticsRepo = createWalletAnalyticsRepo(sql);
  const populationRepo = createPopulationCommonalityRepo(sql);

  // Resolve the wallet's own address: transfer rows store addresses, not
  // wallet ids, and self-exclusion compares against the address (§84).
  const [walletRow] = await sql<Array<{ address: string }>>`
    select address from wallets where id = ${input.walletId}
  `;
  const walletAddress = walletRow?.address ?? null;

  // Load the wallet's normalized observations (bounded).
  const transfers = await analyticsRepo.transfersForWallet(input.walletId, 5000);
  const interactions = await analyticsRepo.programInteractionsForWallet(input.walletId, 5000).catch(() => []);

  const observations = new Map<PopulationObservationType, Map<string, number>>();
  observations.set("COUNTERPARTY", new Map());
  observations.set("PROGRAM", new Map());
  observations.set("MINT", new Map());
  const counterparties = observations.get("COUNTERPARTY")!;
  const programs = observations.get("PROGRAM")!;
  const mints = observations.get("MINT")!;

  for (const t of transfers) {
    // Counterparty = the other side of the transfer (exclude self).
    const cp = t.from_address === walletAddress ? t.to_address : t.to_address === walletAddress ? t.from_address : null;
    if (cp && cp !== walletAddress) counterparties.set(cp, (counterparties.get(cp) ?? 0) + 1);
    if (t.mint) mints.set(t.mint, (mints.get(t.mint) ?? 0) + 1);
  }
  for (const i of interactions) {
    programs.set(i.program_id, (programs.get(i.program_id) ?? 0) + 1);
  }

  const { populationSize } = await populationRepo.replaceContribution({
    walletId: input.walletId,
    analysisId: input.analysisId,
    version,
    observations
  });

  return { populationSize, observations: transfers.length + interactions.length };
}

/**
 * Population commonality availability/resolution (D6-I2 §16-§22).
 *
 * The feature flag turning the SUBSYSTEM on is NOT the same as the empirical
 * penalty being active (§19). The engine only applies population frequencies
 * when ALL of the following hold:
 *   - the feature is enabled (ENABLE_POPULATION_COMMONALITY)
 *   - the analyzed population is large enough (>= COMMONALITY_MIN_POPULATION)
 *   - the snapshot is fresh enough (COMMONALITY_MAX_SNAPSHOT_AGE_HOURS)
 *   - the aggregation exists (rows for the configured version)
 * Otherwise the caller falls back to the D5 static common-activity penalties
 * — correlation never fails because commonality is unavailable, and the
 * fallback is explicit and observable (commonalitySource).
 */

export type CommonalitySource = "POPULATION" | "STATIC" | "FALLBACK";

export interface CommonalityStatus {
  enabled: boolean;
  /** True when population data may influence this calculation. */
  eligible: boolean;
  source: CommonalitySource;
  populationSize: number;
  minimumPopulation: number;
  version: string;
  lastAggregationAt: string | null;
  /** Snapshot age in hours (null when no aggregation exists). */
  snapshotAgeHours: number | null;
  /** True when the snapshot is too old to trust (fallback reason). */
  stale: boolean;
  reason: string;
}

/** Resolves the commonality availability state for a version. */
export async function commonalityStatus(
  ctx: CommonalityContext,
  opts: { version?: string; minPopulation?: number; maxSnapshotAgeHours?: number; enabled: boolean }
): Promise<CommonalityStatus> {
  const { sql } = ctx;
  const version = opts.version ?? POPULATION_COMMONALITY_ENGINE_VERSION;
  const minPopulation = opts.minPopulation ?? 20;
  const maxAgeHours = opts.maxSnapshotAgeHours ?? 336;
  const populationRepo = createPopulationCommonalityRepo(sql);

  const base: CommonalityStatus = {
    enabled: opts.enabled,
    eligible: false,
    source: opts.enabled ? "STATIC" : "STATIC",
    populationSize: 0,
    minimumPopulation: minPopulation,
    version,
    lastAggregationAt: null,
    snapshotAgeHours: null,
    stale: false,
    reason: "population commonality disabled"
  };
  if (!opts.enabled) return base;

  const populationSize = await populationRepo.populationSize(version);
  const lastAggregationAt = await populationRepo.lastAggregationAt(version);
  const snapshotAgeHours = lastAggregationAt
    ? Math.max(0, (Date.now() - new Date(lastAggregationAt).getTime()) / 3_600_000)
    : null;
  const stale = snapshotAgeHours !== null && snapshotAgeHours > maxAgeHours;

  if (populationSize === 0 || !lastAggregationAt) {
    return { ...base, populationSize, lastAggregationAt, snapshotAgeHours: null, source: "FALLBACK", reason: "no population aggregation exists yet" };
  }
  if (populationSize < minPopulation) {
    return {
      ...base,
      populationSize,
      lastAggregationAt,
      snapshotAgeHours,
      source: "FALLBACK",
      reason: `population too small (${populationSize} < ${minPopulation})`
    };
  }
  if (stale) {
    return {
      ...base,
      populationSize,
      lastAggregationAt,
      snapshotAgeHours,
      stale: true,
      source: "FALLBACK",
      reason: `population snapshot is stale (${Math.round(snapshotAgeHours ?? 0)}h > ${maxAgeHours}h)`
    };
  }
  return {
    ...base,
    populationSize,
    lastAggregationAt,
    snapshotAgeHours,
    eligible: true,
    source: "POPULATION",
    reason: "population commonality eligible"
  };
}

/**
 * Loads commonality stats for a set of addresses. Returns a map keyed by
 * address with frequency/population info (missing addresses → sampleAdequate
 * false, frequency 0).
 */
export async function commonalityFor(ctx: CommonalityContext, addresses: string[], opts: { version?: string; minPopulation?: number } = {}): Promise<Map<string, CommonalityForAddress>> {
  const { sql } = ctx;
  const version = opts.version ?? POPULATION_COMMONALITY_ENGINE_VERSION;
  const minPopulation = opts.minPopulation ?? 20;
  const populationRepo = createPopulationCommonalityRepo(sql);
  const unique = [...new Set(addresses)];
  const rows = await populationRepo.statsForKeys(unique, version);
  const result = new Map<string, CommonalityForAddress>();
  for (const addr of unique) {
    result.set(addr, { distinctWallets: 0, observationCount: 0, populationSize: 0, frequency: 0, sampleAdequate: false });
  }
  for (const row of rows) {
    result.set(row.observation_key, {
      distinctWallets: row.distinct_wallets,
      observationCount: row.observation_count,
      populationSize: row.population_size,
      frequency: row.frequency,
      sampleAdequate: row.population_size >= minPopulation
    });
  }
  return result;
}
