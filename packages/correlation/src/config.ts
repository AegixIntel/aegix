/**
 * Correlation weighting configuration, see docs/milestone-d5.md (D5-B §10).
 *
 * Versioned so golden drift detection can attribute score changes to a
 * deliberate weight change rather than an accidental regression.
 * All magic numbers for family combination live here, never in engines.
 */

import type { CorrelationFamily } from "./types.js";

export const CORRELATION_ENGINE_VERSION = "correlation-v1.0.0";

export interface CorrelationFamilyWeights {
  family: CorrelationFamily;
  /** Relative weight in the combined score (does not need to sum to 1). */
  weight: number;
  /** Floor: families below this strength contribute nothing. */
  minimumStrength: number;
}

/**
 * Base weights. Rationale (docs/milestone-d5.md D5-B §10):
 * - FUNDING / TRANSFER_RELATIONSHIP: direct observable value flow — high.
 * - BEHAVIORAL_SIMILARITY: medium (interpretable but weaker than direct flow).
 * - ENTITY_OVERLAP / COUNTERPARTY_OVERLAP / ASSET_FLOW: medium.
 * - TEMPORAL_CORRELATION: medium-low (high base rate; D5-E adjusts further).
 * - PROTOCOL_SEQUENCE_SIMILARITY: very low (shared popular protocols are
 *   common Solana behavior, see common-activity penalty D5-B §12).
 */
export const CORRELATION_FAMILY_WEIGHTS: CorrelationFamilyWeights[] = [
  { family: "FUNDING", weight: 1.0, minimumStrength: 0.1 },
  { family: "TRANSFER_RELATIONSHIP", weight: 0.9, minimumStrength: 0.15 },
  { family: "BEHAVIORAL_SIMILARITY", weight: 0.5, minimumStrength: 0.2 },
  { family: "ENTITY_OVERLAP", weight: 0.45, minimumStrength: 0.15 },
  { family: "COUNTERPARTY_OVERLAP", weight: 0.4, minimumStrength: 0.2 },
  { family: "ASSET_FLOW_CORRELATION", weight: 0.4, minimumStrength: 0.15 },
  { family: "TEMPORAL_CORRELATION", weight: 0.3, minimumStrength: 0.3 },
  { family: "PROTOCOL_SEQUENCE_SIMILARITY", weight: 0.1, minimumStrength: 0.4 }
];

/**
 * Common-activity base rates. Shared use of these carries little
 * correlation value on its own (D5-B §12).
 */
export const COMMON_PROTOCOLS = new Set([
  "Jupiter",
  "Jupiter Aggregator",
  "Raydium",
  "Pump.fun",
  "System Program",
  "Token Program",
  "Token-2022"
]);

export const COMMON_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" // USDT
]);

/**
 * D5-F §30: commonality penalty for ENTITY_OVERLAP. Popular entities
 * (Jupiter, Raydium, USDC infrastructure, common bridges) carry a small
 * correlation value — nearly every Solana wallet touches them. Only
 * uncommon verified entities meaningfully separate wallets.
 *
 * The set stores entity NAMES (registry `name`), and the penalty is applied
 * by matching the shared entity name (and its protocol category).
 */
export const COMMON_ENTITIES = new Set([
  "Jupiter",
  "Raydium AMM",
  "Pump.fun",
  "Wormhole",
  "Orca",
  "Meteora",
  "Marinade",
  "Metaplex"
]);

/** D5-F §30: verified common entities contribute this fraction of their
 * base strength; uncommon verified entities keep full value. */
export const COMMON_ENTITY_STRENGTH_FACTOR = 0.2;

/** Dust threshold: transfers below this SOL-equivalent are not meaningful
 * funding unless repeated (D5-C §18). */
export const FUNDING_DUST_SOL = 0.001;

/** Sample adequacy: cap confidence for small samples (D5-D §28). */
export const MIN_SAMPLE_FOR_FULL_CONFIDENCE = 30;
export const MIN_SAMPLE_FOR_CONFIDENCE = 10;
export const MIN_SAMPLE_FOR_ANY_ASSESSMENT = 3;

/** Temporal short-window (seconds) for paired-activity detection (D5-E §32). */
export const TEMPORAL_SHORT_WINDOW_SECONDS = 60;

/** Versioned temporal windows (D5-E §8) — config, never hard-coded in logic. */
export const TEMPORAL_WINDOWS_SECONDS = [30, 60, 120, 300] as const;

/** Minimum repeated matches for a short-window signal (D5-E §7). */
export const TEMPORAL_MIN_REPEATED_MATCHES = 2;

/** Directional sequence window (seconds), D5-E §12. */
export const TEMPORAL_SEQUENCE_WINDOW_SECONDS = 120;

/** Base-rate guard: expected collision ratio above which evidence is noise. */
export const TEMPORAL_MAX_COLLISION_RATIO = 0.15;

/** Multi-hop funding budget (D5-C §20, strict bounds). */
export const FUNDING_MAX_HOPS = 2;
export const FUNDING_MAX_WALLETS = 50;
export const FUNDING_MAX_TRANSFERS = 2000;
export const FUNDING_HOP_CONFIDENCE_DECAY = 0.7;

/** Behavioral similarity (D5-D §25). */
export const BEHAVIOR_SIMILARITY_FEATURES = [
  "activityHourDistribution",
  "weekdayDistribution",
  "transferSizeDistribution",
  "txIntervalDistribution",
  "protocolDistribution"
] as const;

/** Cluster hypothesis bounds (D5-H §58). */
export const CLUSTER_MAX_MEMBERS = 20;
export const CLUSTER_MIN_EDGE_STRENGTH = 0.3;
export const CLUSTER_MIN_CONFIDENCE = 0.4;
export const CLUSTER_MIN_EVIDENCE_FAMILIES = 2;

/** Confidence cap when semantic coverage is low (D5-D §29). */
export const LOW_SEMANTIC_COVERAGE_CAP = 0.5;
export const LOW_SEMANTIC_COVERAGE_THRESHOLD = 0.4;
