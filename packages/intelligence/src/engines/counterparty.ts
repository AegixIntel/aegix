import type { IntelligenceSignal, NormalizedTransfer } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const COUNTERPARTY_ENGINE_VERSION = "counterparty-v1.0.0";

export interface CounterpartyAnalysisInput {
  walletAddress: string;
  transfers: NormalizedTransfer[];
}

export interface CounterpartyAnalysisResult {
  signals: IntelligenceSignal[];
  counterparties: Array<{
    address: string;
    transactionCount: number;
    totalValue: number;
    lastSeen: string;
  }>;
  uniqueCounterparties: number;
  repeatCounterpartyRatio: number;
  counterpartyConcentration: number;
}

/**
 * Counterparty engine, see architecture.md §54.
 * Identifies unique, repeated and dominant counterparties.
 */
export function analyzeCounterparties(input: CounterpartyAnalysisInput): CounterpartyAnalysisResult {
  const { walletAddress, transfers } = input;

  const byCounterparty = new Map<string, { address: string; transactionCount: number; totalValue: number; lastSeen: string }>();

  for (const t of transfers) {
    if (t.fromAddress === t.toAddress) continue;
    const counterparty = t.fromAddress === walletAddress ? t.toAddress : t.fromAddress;
    const cur = byCounterparty.get(counterparty) ?? {
      address: counterparty,
      transactionCount: 0,
      totalValue: 0,
      lastSeen: t.timestamp
    };
    cur.transactionCount += 1;
    cur.totalValue += t.amountNormalized;
    if (t.timestamp > cur.lastSeen) cur.lastSeen = t.timestamp;
    byCounterparty.set(counterparty, cur);
  }

  const counterparties = [...byCounterparty.values()].sort((a, b) => b.transactionCount - a.transactionCount);
  const uniqueCounterparties = counterparties.length;
  const repeated = counterparties.filter((c) => c.transactionCount >= 2);
  const repeatCounterpartyRatio = uniqueCounterparties > 0 ? repeated.length / uniqueCounterparties : 0;
  const totalTx = counterparties.reduce((sum, c) => sum + c.transactionCount, 0);
  const counterpartyConcentration = totalTx > 0 ? (counterparties[0]?.transactionCount ?? 0) / totalTx : 0;

  const signals: IntelligenceSignal[] = [];

  if (repeated.length > 0) {
    const top = repeated[0]!;
    signals.push(
      makeSignal(
        {
          type: "REPEATED_COUNTERPARTY",
          category: "COUNTERPARTY",
          severity: Math.min(70, 35 + top.transactionCount * 4),
          confidence: Math.min(0.9, 0.45 + top.transactionCount * 0.025),
          title: "Repeated counterparty",
          summary: `This wallet interacted with ${top.address} ${top.transactionCount} times.`,
          evidence: [
            { key: "counterparty", value: top.address, label: "Counterparty" },
            { key: "count", value: top.transactionCount, label: "Interaction count" }
          ]
        },
        COUNTERPARTY_ENGINE_VERSION
      )
    );
  }

  if (uniqueCounterparties === 0) {
    signals.push(
      makeSignal(
        {
          type: "NO_COUNTERPARTIES",
          category: "COUNTERPARTY",
          severity: 5,
          confidence: 0.9,
          title: "No counterparties observed",
          summary: "No transfer counterparties were observed in the analyzed window.",
          evidence: []
        },
        COUNTERPARTY_ENGINE_VERSION
      )
    );
  }

  return {
    signals,
    counterparties,
    uniqueCounterparties,
    repeatCounterpartyRatio,
    counterpartyConcentration
  };
}
