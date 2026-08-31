/**
 * FUNDING / TRANSFER_RELATIONSHIP evidence family, see docs/milestone-d5.md
 * (D5-B §9, D5-C).
 *
 * Direct observable value flow between the two wallets. Dust transfers are
 * excluded unless repeated (D5-C §18). Evidence independence: a transfer is
 * counted once — the funding family counts incoming flow to the target, the
 * transfer family counts bidirectional/repeated flow; overlapping signatures
 * are attributed to one family only (the more specific one).
 */

import { FUNDING_DUST_SOL } from "../config.js";
import type { EvidenceFamilyResult, EvidencePoint } from "../types.js";
import type { TransferRow } from "@aegix/database";

export const FUNDING_FAMILY_ENGINE_VERSION = "funding-family-v1.0.0";
export const TRANSFER_FAMILY_ENGINE_VERSION = "transfer-family-v1.0.0";

export interface FundingTransferInput {
  walletA: string;
  walletB: string;
  transfersA: TransferRow[]; // transfers involving wallet A (from or to)
  transfersB: TransferRow[]; // transfers involving wallet B (from or to)
}

interface FlowStats {
  count: number;
  totalValue: number;
  signatures: Set<string>;
  firstSeen: string;
  lastSeen: string;
  dustCount: number;
  meaningfulCount: number;
}

function flowBetween(transfers: TransferRow[], from: string, to: string): FlowStats {
  const stats: FlowStats = {
    count: 0,
    totalValue: 0,
    signatures: new Set(),
    firstSeen: "",
    lastSeen: "",
    dustCount: 0,
    meaningfulCount: 0
  };
  for (const t of transfers) {
    if (t.from_address !== from || t.to_address !== to) continue;
    const value = Number(t.amount_normalized) || 0;
    stats.count += 1;
    stats.totalValue += value;
    stats.signatures.add(t.transaction_id);
    if (value < FUNDING_DUST_SOL) stats.dustCount += 1;
    else stats.meaningfulCount += 1;
    if (!stats.firstSeen || t.block_time < stats.firstSeen) stats.firstSeen = t.block_time;
    if (t.block_time > stats.lastSeen) stats.lastSeen = t.block_time;
  }
  return stats;
}

function evidence(points: EvidencePoint[]): EvidencePoint[] {
  return points;
}

/**
 * Direct funding: A funded by B (incoming to A from B) or vice versa.
 * Returns null when there is no meaningful flow.
 */
export function evaluateFundingFamily(input: FundingTransferInput): EvidenceFamilyResult | null {
  const { walletA, walletB } = input;
  const aFromB = flowBetween(input.transfersA, walletB, walletA);
  const bFromA = flowBetween(input.transfersB, walletA, walletB);

  const totalIncoming = aFromB.count + bFromA.count;
  if (totalIncoming === 0) return null;

  // Dust-only flow (no meaningful transfer) is not a funding relationship.
  if (aFromB.meaningfulCount === 0 && bFromA.meaningfulCount === 0) return null;

  const dominant = aFromB.totalValue >= bFromA.totalValue ? aFromB : bFromA;
  const dominantFrom = aFromB.totalValue >= bFromA.totalValue ? walletB : walletA;
  const dominantTo = aFromB.totalValue >= bFromA.totalValue ? walletA : walletB;

  // Strength: repeated meaningful transfers dominate; a single transfer is
  // weak evidence (D5-B §13). Value adds only a bounded bonus.
  const repeatFactor = Math.min(1, dominant.meaningfulCount / 6);
  const valueFactor = Math.min(1, dominant.totalValue / 100);
  const strength = Math.min(1, 0.2 + repeatFactor * 0.55 + valueFactor * 0.15);

  const confidence = Math.min(0.98, 0.5 + dominant.meaningfulCount * 0.06 + (dominant.dustCount === 0 ? 0.1 : 0));

  const points = evidence([
    { key: "direction", value: `${dominantFrom.slice(0, 6)}… → ${dominantTo.slice(0, 6)}…`, label: "Funding direction" },
    { key: "meaningful_transfers", value: dominant.meaningfulCount, label: "Meaningful transfers" },
    { key: "dust_transfers", value: dominant.dustCount, label: "Dust transfers (excluded)" },
    { key: "total_value", value: Math.round(dominant.totalValue * 100) / 100, label: "Total value" },
    { key: "first_seen", value: dominant.firstSeen, label: "First seen" },
    { key: "last_seen", value: dominant.lastSeen, label: "Last seen" }
  ]);

  return {
    family: "FUNDING",
    strength,
    confidence,
    summary: `Direct funding observed: ${dominant.meaningfulCount} meaningful transfer(s) from ${dominantFrom.slice(0, 6)}… to ${dominantTo.slice(0, 6)}…`,
    evidence: points,
    limitations: [
      "Funding flow is observable; it does not prove the wallets share an owner."
    ],
    engineVersion: FUNDING_FAMILY_ENGINE_VERSION
  };
}

/**
 * Transfer relationship: repeated or bidirectional flow, including outgoing.
 * Evidence-independent from FUNDING: only counts flow in the direction not
 * already attributed to funding (the outgoing side).
 */
export function evaluateTransferFamily(input: FundingTransferInput): EvidenceFamilyResult | null {
  const { walletA, walletB } = input;
  const aToB = flowBetween(input.transfersA, walletA, walletB);
  const bToA = flowBetween(input.transfersB, walletB, walletA);

  const total = aToB.count + bToA.count;
  if (total === 0) return null;
  // Exclude pure dust and pure one-way that funding already captured.
  if (aToB.meaningfulCount === 0 && bToA.meaningfulCount === 0) return null;

  const bidirectional = aToB.meaningfulCount > 0 && bToA.meaningfulCount > 0;
  const repeatFactor = Math.min(1, total / 6);
  const strength = Math.min(1, 0.25 + repeatFactor * 0.5 + (bidirectional ? 0.25 : 0));

  const confidence = Math.min(0.95, 0.4 + total * 0.05 + (bidirectional ? 0.15 : 0));

  const points = evidence([
    { key: "transfers_a_to_b", value: aToB.meaningfulCount, label: "A → B (meaningful)" },
    { key: "transfers_b_to_a", value: bToA.meaningfulCount, label: "B → A (meaningful)" },
    { key: "bidirectional", value: bidirectional, label: "Bidirectional" },
    { key: "first_seen", value: aToB.firstSeen || bToA.firstSeen, label: "First seen" },
    { key: "last_seen", value: aToB.lastSeen || bToA.lastSeen, label: "Last seen" }
  ]);

  return {
    family: "TRANSFER_RELATIONSHIP",
    strength,
    confidence,
    summary: `Repeated transfer relationship: ${aToB.meaningfulCount} A→B, ${bToA.meaningfulCount} B→A (meaningful)`,
    evidence: points,
    limitations: [
      "Repeated transfers between addresses are observable; they do not establish common ownership."
    ],
    engineVersion: TRANSFER_FAMILY_ENGINE_VERSION
  };
}
