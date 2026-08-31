/**
 * COUNTERPARTY_OVERLAP / ENTITY_OVERLAP evidence families, see
 * docs/milestone-d5.md (D5-B §9, §12-§13).
 *
 * Shared counterparties are common-activity-penalized: sharing popular
 * protocols/mints carries very little weight. Rare shared counterparties
 * (uncommon addresses) carry more. Evidence independence: counterparty
 * overlap counts counterparties that are NOT the two wallets being compared
 * and NOT known hubs — the direct flow between A and B is already counted
 * by the FUNDING/TRANSFER families.
 */

import { COMMON_MINTS, COMMON_PROTOCOLS } from "../config.js";
import type { EvidenceFamilyResult } from "../types.js";
import type { TransferRow } from "@aegix/database";

export interface OverlapInput {
  walletA: string;
  walletB: string;
  transfersA: TransferRow[];
  transfersB: TransferRow[];
  /** Program interactions for each wallet: programId -> label. */
  interactionsA?: Array<{ program_id: string; program_label: string | null }>;
  interactionsB?: Array<{ program_id: string; program_label: string | null }>;
  /** Known entity addresses (verified registry). */
  knownEntityAddresses?: Set<string>;
}

function counterpartySet(transfers: TransferRow[], self: string, other: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of transfers) {
    const cp = t.from_address === self ? t.to_address : t.to_address === self ? t.from_address : null;
    if (!cp || cp === self || cp === other) continue;
    // Exclude mint addresses (common activity).
    if (COMMON_MINTS.has(cp)) continue;
    map.set(cp, (map.get(cp) ?? 0) + 1);
  }
  return map;
}

/** Hub heuristic: addresses appearing as counterparty in many transfers. */
export function isHubAddress(address: string, allTransfers: TransferRow[], threshold = 50): boolean {
  let count = 0;
  for (const t of allTransfers) {
    if (t.from_address === address || t.to_address === address) {
      count += 1;
      if (count >= threshold) return true;
    }
  }
  return false;
}

export function evaluateCounterpartyOverlap(input: OverlapInput): EvidenceFamilyResult | null {
  const { walletA, walletB } = input;
  const cpsA = counterpartySet(input.transfersA, walletA, walletB);
  const cpsB = counterpartySet(input.transfersB, walletB, walletA);

  // Global frequency of each counterparty across BOTH wallets' transfers:
  // an address that appears many times is a hub/common service, not a rare
  // shared signal (D5-B §12-§13).
  const globalCount = new Map<string, number>();
  for (const t of [...input.transfersA, ...input.transfersB]) {
    const cp = t.from_address === walletA ? t.to_address : t.from_address === walletB ? t.to_address : t.to_address === walletA ? t.from_address : t.to_address === walletB ? t.from_address : null;
    if (!cp || cp === walletA || cp === walletB) continue;
    globalCount.set(cp, (globalCount.get(cp) ?? 0) + 1);
  }

  // Shared intersection with rarity weighting.
  const shared: Array<{ address: string; rarity: number; countA: number; countB: number }> = [];
  for (const [cp, countA] of cpsA) {
    const countB = cpsB.get(cp);
    if (!countB) continue;
    const appearances = globalCount.get(cp) ?? (countA + countB);
    // Rarity: 1 for addresses seen once per wallet; decays fast for hubs.
    const rarity = Math.min(1, 3 / (1 + appearances));
    shared.push({ address: cp, rarity, countA, countB });
  }

  if (shared.length === 0) return null;

  const meaningful = shared.filter((s) => s.rarity > 0.3);
  if (meaningful.length === 0) return null;

  const overlapFactor = Math.min(1, meaningful.length / 3);
  const rarityBoost = meaningful.reduce((sum, s) => sum + s.rarity, 0) / meaningful.length;
  // Shared counterparties alone must never reach strong correlation.
  const strength = Math.min(0.55, overlapFactor * 0.4 + rarityBoost * 0.25);

  const confidence = Math.min(0.8, 0.3 + meaningful.length * 0.08);

  return {
    family: "COUNTERPARTY_OVERLAP",
    strength,
    confidence,
    summary: `Shared non-hub counterparties: ${meaningful.map((s) => s.address.slice(0, 6) + "…").join(", ")}`,
    evidence: meaningful.slice(0, 5).map((s) => ({
      key: "shared_counterparty",
      value: s.address,
      label: `Shared counterparty (A:${s.countA}, B:${s.countB})`
    })),
    limitations: [
      "Shared counterparties could reflect common use of a public service, not a personal relationship."
    ]
  };
}

export function evaluateEntityOverlap(input: OverlapInput): EvidenceFamilyResult | null {
  const { walletA, walletB, knownEntityAddresses } = input;
  if (!knownEntityAddresses || knownEntityAddresses.size === 0) return null;

  const entitiesA = new Set<string>();
  const entitiesB = new Set<string>();
  for (const t of input.transfersA) {
    if (knownEntityAddresses.has(t.from_address)) entitiesA.add(t.from_address);
    if (knownEntityAddresses.has(t.to_address)) entitiesA.add(t.to_address);
  }
  for (const t of input.transfersB) {
    if (knownEntityAddresses.has(t.from_address)) entitiesB.add(t.from_address);
    if (knownEntityAddresses.has(t.to_address)) entitiesB.add(t.to_address);
  }

  const shared = [...entitiesA].filter((e) => entitiesB.has(e));
  if (shared.length === 0) return null;

  // Interacting with the same verified exchange/service is common public
  // behavior — never strong on its own (D5-B §12).
  const strength = Math.min(0.6, 0.2 + shared.length * 0.15);
  const confidence = Math.min(0.7, 0.35 + shared.length * 0.1);

  return {
    family: "ENTITY_OVERLAP",
    strength,
    confidence,
    summary: `Both wallets interact with the same verified entity/entities (${shared.length})`,
    evidence: shared.map((e) => ({ key: "shared_entity", value: e, label: "Shared entity address" })),
    limitations: [
      "Interacting with the same exchange or service is common public behavior and weak evidence of a personal relationship."
    ]
  };
}

/** PROTOCOL_SEQUENCE_SIMILARITY: shared program usage with common-activity penalty. */
export function evaluateProtocolSimilarity(input: OverlapInput): EvidenceFamilyResult | null {
  const labelsA = new Set((input.interactionsA ?? []).map((i) => i.program_label ?? i.program_id));
  const labelsB = new Set((input.interactionsB ?? []).map((i) => i.program_label ?? i.program_id));
  if (labelsA.size === 0 || labelsB.size === 0) return null;

  const shared = [...labelsA].filter((l) => labelsB.has(l));
  const uncommon = shared.filter((l) => !COMMON_PROTOCOLS.has(l));
  if (uncommon.length === 0) return null; // shared common protocols alone → no correlation

  const strength = Math.min(0.6, 0.2 + uncommon.length * 0.1);
  const confidence = Math.min(0.7, 0.3 + uncommon.length * 0.08);

  return {
    family: "PROTOCOL_SEQUENCE_SIMILARITY",
    strength,
    confidence,
    summary: `Both wallets use uncommon protocol(s): ${uncommon.join(", ")}`,
    evidence: uncommon.map((p) => ({ key: "shared_protocol", value: p, label: "Uncommon shared protocol" })),
    limitations: [
      "Shared protocol usage alone is weak evidence; popular protocols are deliberately excluded."
    ]
  };
}
