import type { ScoringConfig } from "@aegix/types";

/**
 * Versioned scoring configuration, see architecture.md §123.
 * Weights are committed with code and versioned; never hard-coded in engines.
 */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  scoringVersion: "score-v1.0.0",
  fundingExposure: {
    repeated_funder: 0.25,
    concentration: 0.2,
    known_entity: 0.2,
    cross_wallet_reuse: 0.2,
    timing_pattern: 0.15
  },
  identityLinkability: {
    repeated_funding: 0.3,
    repeated_counterparty: 0.3,
    shared_counterparty: 0.2,
    public_attribution: 0.2
  },
  walletClusterExposure: {
    potential_cluster_link: 0.5,
    shared_counterparty: 0.3,
    behavior_similarity: 0.2
  },
  behavioralFingerprint: {
    narrow_activity_window: 0.4,
    single_protocol_use: 0.3,
    regular_intervals: 0.3
  },
  counterpartyExposure: {
    repeated_counterparty: 0.4,
    dominant_counterparty: 0.3,
    unique_counterparties: 0.3
  },
  entityExposure: {
    known_entity_interaction: 0.6,
    exchange_interaction: 0.4
  },
  transactionPatternExposure: {
    large_transfers: 0.4,
    high_frequency: 0.3,
    odd_hours: 0.3
  },
  dimensionWeights: {
    identityLinkability: 0.2,
    fundingExposure: 0.2,
    walletClusterExposure: 0.15,
    behavioralFingerprint: 0.15,
    counterpartyExposure: 0.1,
    entityExposure: 0.1,
    transactionPatternExposure: 0.1
  }
};
