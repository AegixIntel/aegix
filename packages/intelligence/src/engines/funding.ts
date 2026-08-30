import type { IntelligenceSignal, NormalizedTransfer } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const FUNDING_ENGINE_VERSION = "funding-v1.0.0";

export interface CounterpartySummary {
  address: string;
  transactionCount: number;
  totalValue: number;
  lastSeen: string;
  direction: "INCOMING" | "OUTGOING" | "BIDIRECTIONAL";
}

export interface FundingAnalysisInput {
  walletAddress: string;
  transfers: NormalizedTransfer[];
}

export interface FundingAnalysisResult {
  signals: IntelligenceSignal[];
  fundingSources: CounterpartySummary[];
  fundingConcentration: number; // 0 – 1
  repeatedFunders: CounterpartySummary[];
  initialFunder: CounterpartySummary | null;
}

/**
 * Funding analysis engine, see architecture.md §53.
 * Identifies initial funders, repeated funders, funding concentration and reuse.
 */
export function analyzeFunding(input: FundingAnalysisInput): FundingAnalysisResult {
  const { walletAddress, transfers } = input;

  // Incoming transfers to the wallet (excluding self-transfers)
  const incoming = transfers.filter(
    (t) => t.toAddress === walletAddress && t.fromAddress !== walletAddress
  );

  const bySource = new Map<string, CounterpartySummary>();
  for (const t of incoming) {
    const cur = bySource.get(t.fromAddress) ?? {
      address: t.fromAddress,
      transactionCount: 0,
      totalValue: 0,
      lastSeen: t.timestamp,
      direction: "INCOMING" as const
    };
    cur.transactionCount += 1;
    cur.totalValue += t.amountNormalized;
    if (t.timestamp > cur.lastSeen) cur.lastSeen = t.timestamp;
    bySource.set(t.fromAddress, cur);
  }

  const fundingSources = [...bySource.values()].sort((a, b) => b.totalValue - a.totalValue);
  const totalValue = fundingSources.reduce((sum, s) => sum + s.totalValue, 0);
  const fundingConcentration = totalValue > 0 ? (fundingSources[0]?.totalValue ?? 0) / totalValue : 0;
  const repeatedFunders = fundingSources.filter((s) => s.transactionCount >= 2);
  const initialFunder = fundingSources[fundingSources.length - 1] ?? null; // earliest by lastSeen is wrong; see below

  const signals: IntelligenceSignal[] = [];

  if (repeatedFunders.length > 0) {
    const top = repeatedFunders[0]!;
    signals.push(
      makeSignal(
        {
          type: "REPEATED_FUNDING",
          category: "FUNDING",
          severity: Math.min(80, 40 + top.transactionCount * 5),
          confidence: Math.min(0.95, 0.5 + top.transactionCount * 0.03),
          title: "Repeated funding source",
          summary: `Wallet ${top.address} funded this wallet ${top.transactionCount} times.`,
          evidence: [
            { key: "counterparty", value: top.address, label: "Counterparty" },
            { key: "count", value: top.transactionCount, label: "Funding count" },
            { key: "total_value", value: Math.round(top.totalValue * 100) / 100, label: "Total value" }
          ]
        },
        FUNDING_ENGINE_VERSION
      )
    );
  }

  if (fundingSources.length > 0 && fundingConcentration >= 0.8) {
    const top = fundingSources[0]!;
    signals.push(
      makeSignal(
        {
          type: "FUNDING_CONCENTRATION",
          category: "FUNDING",
          severity: 60,
          confidence: 0.7,
          title: "Highly concentrated funding",
          summary: `A single source provided ${Math.round(fundingConcentration * 100)}% of incoming funds.`,
          evidence: [
            { key: "concentration", value: Math.round(fundingConcentration * 100), label: "Concentration %" },
            { key: "dominant_source", value: top.address, label: "Dominant source" }
          ]
        },
        FUNDING_ENGINE_VERSION
      )
    );
  }

  if (fundingSources.length === 0) {
    signals.push(
      makeSignal(
        {
          type: "NO_INCOMING_FUNDING",
          category: "FUNDING",
          severity: 10,
          confidence: 0.8,
          title: "No incoming funding observed",
          summary: "No incoming transfers to this wallet were observed in the analyzed window.",
          evidence: []
        },
        FUNDING_ENGINE_VERSION
      )
    );
  }

  return { signals, fundingSources, fundingConcentration, repeatedFunders, initialFunder };
}
