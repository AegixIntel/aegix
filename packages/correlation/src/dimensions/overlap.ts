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

import { COMMON_ENTITIES, COMMON_ENTITY_STRENGTH_FACTOR, COMMON_MINTS, COMMON_PROTOCOLS } from "../config.js";
import type { EvidenceFamilyResult } from "../types.js";
import type { TransferRow } from "@aegix/database";

export const COUNTERPARTY_OVERLAP_ENGINE_VERSION = "counterparty-overlap-v1.1.0";
export const ENTITY_OVERLAP_ENGINE_VERSION = "entity-overlap-v1.1.0";
export const PROTOCOL_SIMILARITY_ENGINE_VERSION = "protocol-similarity-v1.1.0";

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
  /** D5-F §29: entity name per address, for commonality-aware overlap. */
  entityNamesByAddress?: Map<string, string>;
  /** D5-F §28: entity record verification confidence per address. */
  entityConfidenceByAddress?: Map<string, number>;
  /** D6-G §89: observed population frequency per address (0-1). When
   *  present, shared-key rarity uses population frequency instead of the
   *  two-wallet-local count (correlation penalty v2). */
  commonalityByAddress?: Map<string, number>;
  /** D6-G §84: minimum analyzed population before commonality applies. */
  commonalityMinPopulation?: number;
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

  // D6-G §89: population-aware rarity (correlation penalty v2). When the
  // analyzed population provides a frequency for a shared counterparty, a
  // very common address is heavily discounted; a rare one keeps its value.
  const population = input.commonalityByAddress;
  const minPopulation = input.commonalityMinPopulation ?? 20;
  const populationPenalty = (address: string): number => {
    if (!population || !population.has(address)) return 0;
    const freq = Math.min(1, Math.max(0, population.get(address) ?? 0));
    // Below the rarity floor: no penalty. Above it: smooth ramp to 0.9.
    if (freq < 0.05) return 0;
    const t = Math.min(1, (freq - 0.05) / 0.95);
    return Math.round(0.9 * (t * t * (3 - 2 * t)) * 100) / 100;
  };

  // Shared intersection with rarity weighting.
  const shared: Array<{ address: string; rarity: number; countA: number; countB: number }> = [];
  for (const [cp, countA] of cpsA) {
    const countB = cpsB.get(cp);
    if (!countB) continue;
    const appearances = globalCount.get(cp) ?? (countA + countB);
    // Rarity: 1 for addresses seen once per wallet; decays fast for hubs.
    const rarity = Math.min(1, 3 / (1 + appearances));
    const penalty = populationPenalty(cp);
    shared.push({ address: cp, rarity: Math.max(0, rarity - penalty), countA, countB });
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
    ],
    engineVersion: COUNTERPARTY_OVERLAP_ENGINE_VERSION
  };
}

export function evaluateEntityOverlap(input: OverlapInput): EvidenceFamilyResult | null {
  const { walletA, walletB, knownEntityAddresses } = input;
  if (!knownEntityAddresses || knownEntityAddresses.size === 0) return null;

  // Per-address interaction counts (D5-F §29: repeated interaction with the
  // same uncommon verified entity is stronger than a single touch).
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const t of input.transfersA) {
    if (knownEntityAddresses.has(t.from_address)) countA.set(t.from_address, (countA.get(t.from_address) ?? 0) + 1);
    if (knownEntityAddresses.has(t.to_address)) countA.set(t.to_address, (countA.get(t.to_address) ?? 0) + 1);
  }
  for (const t of input.transfersB) {
    if (knownEntityAddresses.has(t.from_address)) countB.set(t.from_address, (countB.get(t.from_address) ?? 0) + 1);
    if (knownEntityAddresses.has(t.to_address)) countB.set(t.to_address, (countB.get(t.to_address) ?? 0) + 1);
  }

  const shared = [...countA.keys()].filter((e) => countB.has(e));
  if (shared.length === 0) return null;

  const namesByAddress = input.entityNamesByAddress ?? new Map<string, string>();
  const confidenceByAddress = input.entityConfidenceByAddress ?? new Map<string, number>();

  // Commonality-aware contribution (D5-F §30): common entities contribute a
  // flat 0.05 (below the ENTITY_OVERLAP minimumStrength — they add nothing
  // meaningful); uncommon verified entities contribute 0.25 + 0.25·repetition
  // (0.25 single touch, up to 0.5 for repeated interaction on both sides).
  const contributions = shared.map((addr) => {
    const name = namesByAddress.get(addr) ?? addr;
    const common = COMMON_ENTITIES.has(name);
    const repeatA = Math.min(1, (countA.get(addr) ?? 1) / 5);
    const repeatB = Math.min(1, (countB.get(addr) ?? 1) / 5);
    const repetition = Math.min(1, repeatA * repeatB * 1.5);
    const contribution = common ? 0.05 : 0.25 + 0.25 * repetition;
    return { address: addr, name, common, contribution };
  });

  // Uncommon-only strength: shared popular entities must not stack into a
  // strong signal (D5-F §30).
  const uncommon = contributions.filter((c) => !c.common);
  const meaningful = uncommon.length > 0 ? uncommon : contributions;
  const strength = Math.min(0.5, meaningful.reduce((sum, c) => sum + c.contribution, 0));

  // Confidence: number of shared entities + record verification confidence
  // (not exposure confidence). Never high for common entities.
  const recordConfidence = Math.min(...shared.map((addr) => confidenceByAddress.get(addr) ?? 1));
  let confidence = Math.min(0.7, 0.3 + shared.length * 0.08 + (uncommon.length > 0 ? 0.15 : 0));
  confidence *= recordConfidence;

  return {
    family: "ENTITY_OVERLAP",
    strength: Math.round(strength * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    summary: `Both wallets interact with the same verified entity/entities (${shared.length}${uncommon.length > 0 ? `, ${uncommon.length} uncommon` : ""})`,
    evidence: meaningful.slice(0, 5).map((c) => ({
      key: "shared_entity",
      value: c.address,
      label: `${c.name}${c.common ? " (common)" : " (uncommon)"} — A:${countA.get(c.address)}, B:${countB.get(c.address)}`
    })),
    limitations: [
      "Interacting with the same exchange or service is common public behavior and weak evidence of a personal relationship.",
      uncommon.length === 0
        ? "Only popular/common verified entities are shared — nearly every Solana wallet interacts with them."
        : "Uncommon verified entity overlap still describes observable behavior, not ownership."
    ],
    engineVersion: ENTITY_OVERLAP_ENGINE_VERSION
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
    ],
    engineVersion: PROTOCOL_SIMILARITY_ENGINE_VERSION
  };
}
