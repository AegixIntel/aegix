import type { IntelligenceSignal, NormalizedTransfer } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const CLUSTER_ENGINE_VERSION = "cluster-v1.0.0";

export interface ClusterAnalysisInput {
  walletAddress: string;
  transfers: NormalizedTransfer[];
  /** Shared counterparties seen across analyzed wallets, address -> count. */
  sharedCounterparties: Map<string, number>;
}

export interface ClusterAnalysisResult {
  signals: IntelligenceSignal[];
  sharedCounterpartyLinks: Array<{ counterparty: string; shareCount: number }>;
}

/**
 * Cluster engine, see architecture.md §56.
 * Emits POTENTIAL_CLUSTER_LINK signals only — never ownership claims.
 */
export function analyzeClusters(input: ClusterAnalysisInput): ClusterAnalysisResult {
  const { sharedCounterparties } = input;

  const sharedCounterpartyLinks = [...sharedCounterparties.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([counterparty, shareCount]) => ({ counterparty, shareCount }));

  const signals: IntelligenceSignal[] = sharedCounterpartyLinks.map(({ counterparty, shareCount: count }) =>
    makeSignal(
      {
        type: "POTENTIAL_CLUSTER_LINK",
        category: "CLUSTER",
        severity: Math.min(60, 30 + count * 10),
        confidence: Math.min(0.6, 0.3 + count * 0.05),
        title: "Shared counterparty signal",
        summary: `This wallet shares counterparty ${counterparty} with ${count} other analyzed wallet(s).`,
        evidence: [
          { key: "counterparty", value: counterparty, label: "Shared counterparty" },
          { key: "share_count", value: count, label: "Sharing wallets" }
        ]
      },
      CLUSTER_ENGINE_VERSION
    )
  );

  return { signals, sharedCounterpartyLinks };
}
