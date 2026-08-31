/**
 * Funding provenance engine v2, see docs/milestone-d5.md (D5-C).
 *
 * Evolves funding intelligence from "who sent funds?" to "where did
 * economically meaningful funding originate?" — with strict budgets:
 *   - max 2 funding hops (target ← X ← Y)
 *   - max 50 wallets, max 2000 transfers read from persisted data
 *   - never recursive RPC crawling
 *
 * Each hop carries strength + confidence + evidence; overall path confidence
 * decays per hop (FUNDING_HOP_CONFIDENCE_DECAY). When the terminus is a
 * verified entity, the report says "potential funding path to verified
 * entity" — never "exchange user identified".
 */

import type { TransferRow } from "@aegix/database";
import { FUNDING_DUST_SOL, FUNDING_HOP_CONFIDENCE_DECAY, FUNDING_MAX_HOPS, FUNDING_MAX_TRANSFERS, FUNDING_MAX_WALLETS } from "./config.js";

export const FUNDING_PROVENANCE_ENGINE_VERSION = "funding-provenance-v1.0.0";

export interface FundingHop {
  hop: number;
  fromAddress: string;
  toAddress: string;
  strength: number;
  confidence: number;
  transferCount: number;
  totalValue: number;
  firstSeen: string;
  lastSeen: string;
}

export interface FundingPath {
  targetWallet: string;
  /** Hops from target outward: hop[0] is the direct funder of target. */
  hops: FundingHop[];
  pathScore: number;
  pathConfidence: number;
  /** ENTITY when the terminus is a known verified entity, else WALLET. */
  terminusType: "ENTITY" | "WALLET";
  terminusAddress: string;
  terminusEntityName: string | null;
  engineVersion: string;
}

export interface FundingProvenanceInput {
  targetWallet: string;
  /** Transfers involving the target wallet (from persisted DB). */
  targetTransfers: TransferRow[];
  /**
   * Bounded fetcher for a wallet's transfers (DB-backed; the caller bounds
   * the number of wallets and transfers, e.g. via MAX_SECONDARY_* config).
   */
  fetchTransfers: (walletAddress: string) => Promise<TransferRow[]>;
  /** Known verified entity addresses: address -> entity name. */
  knownEntities?: Map<string, string>;
  maxHops?: number;
  maxWallets?: number;
  maxTransfers?: number;
}

interface Funder {
  address: string;
  transferCount: number;
  totalValue: number;
  firstSeen: string;
  lastSeen: string;
}

function fundersOf(wallet: string, transfers: TransferRow[]): Funder[] {
  const map = new Map<string, Funder>();
  for (const t of transfers) {
    if (t.to_address !== wallet || t.from_address === wallet) continue;
    const value = Number(t.amount_normalized) || 0;
    // Dust-only funding is ignored (D5-C §18).
    if (value < FUNDING_DUST_SOL) continue;
    const cur = map.get(t.from_address) ?? {
      address: t.from_address,
      transferCount: 0,
      totalValue: 0,
      firstSeen: t.block_time,
      lastSeen: t.block_time
    };
    cur.transferCount += 1;
    cur.totalValue += value;
    if (t.block_time < cur.firstSeen) cur.firstSeen = t.block_time;
    if (t.block_time > cur.lastSeen) cur.lastSeen = t.block_time;
    map.set(t.from_address, cur);
  }
  return [...map.values()].sort((a, b) => b.totalValue - a.totalValue);
}

function hopStrength(funder: Funder): number {
  const repeat = Math.min(1, funder.transferCount / 5);
  const value = Math.min(1, funder.totalValue / 100);
  return Math.min(1, 0.3 + repeat * 0.45 + value * 0.25);
}

/**
 * Bounded multi-hop funding provenance. Returns ranked paths (strongest
 * first), each ending at a wallet or verified entity terminus.
 */
export async function traceFundingProvenance(input: FundingProvenanceInput): Promise<FundingPath[]> {
  const {
    targetWallet,
    targetTransfers,
    fetchTransfers,
    knownEntities = new Map(),
    maxHops = FUNDING_MAX_HOPS,
    maxWallets = FUNDING_MAX_WALLETS,
    maxTransfers = FUNDING_MAX_TRANSFERS
  } = input;

  const paths: FundingPath[] = [];
  const visitedWallets = new Set<string>([targetWallet]);
  let transferBudget = maxTransfers;

  // Direct funders (hop 1).
  const direct = fundersOf(targetWallet, targetTransfers);
  const expanded = new Map<string, TransferRow[]>(); // wallet -> its transfers (cached, bounded)

  const expand = async (wallet: string): Promise<TransferRow[]> => {
    if (expanded.has(wallet)) return expanded.get(wallet)!;
    if (visitedWallets.size >= maxWallets) return [];
    const rows = await fetchTransfers(wallet);
    transferBudget -= rows.length;
    expanded.set(wallet, rows);
    return transferBudget < 0 ? [] : rows;
  };

  for (const funder of direct) {
    visitedWallets.add(funder.address);
    const entityName = knownEntities.get(funder.address);
    const directPath: FundingPath = {
      targetWallet,
      hops: [
        {
          hop: 1,
          fromAddress: funder.address,
          toAddress: targetWallet,
          strength: hopStrength(funder),
          confidence: Math.min(0.95, 0.5 + funder.transferCount * 0.06),
          transferCount: funder.transferCount,
          totalValue: funder.totalValue,
          firstSeen: funder.firstSeen,
          lastSeen: funder.lastSeen
        }
      ],
      pathScore: hopStrength(funder),
      pathConfidence: Math.min(0.95, 0.5 + funder.transferCount * 0.06),
      terminusType: entityName ? "ENTITY" : "WALLET",
      terminusAddress: funder.address,
      terminusEntityName: entityName ?? null,
      engineVersion: FUNDING_PROVENANCE_ENGINE_VERSION
    };
    paths.push(directPath);

    // Hop 2: funder's own funders (bounded).
    if (maxHops >= 2 && !entityName) {
      const funderTransfers = await expand(funder.address);
      if (funderTransfers.length > 0) {
        for (const grandFunder of fundersOf(funder.address, funderTransfers)) {
          if (visitedWallets.size >= maxWallets) break;
          if (visitedWallets.has(grandFunder.address)) continue;
          visitedWallets.add(grandFunder.address);
          const grandEntity = knownEntities.get(grandFunder.address);
          const hop2Strength = hopStrength(grandFunder);
          paths.push({
            targetWallet,
            hops: [
              ...directPath.hops,
              {
                hop: 2,
                fromAddress: grandFunder.address,
                toAddress: funder.address,
                strength: hop2Strength,
                confidence: Math.min(0.9, 0.4 + grandFunder.transferCount * 0.06),
                transferCount: grandFunder.transferCount,
                totalValue: grandFunder.totalValue,
                firstSeen: grandFunder.firstSeen,
                lastSeen: grandFunder.lastSeen
              }
            ],
            pathScore: directPath.pathScore * hop2Strength,
            pathConfidence: directPath.pathConfidence * FUNDING_HOP_CONFIDENCE_DECAY * Math.min(0.9, 0.4 + grandFunder.transferCount * 0.06),
            terminusType: grandEntity ? "ENTITY" : "WALLET",
            terminusAddress: grandFunder.address,
            terminusEntityName: grandEntity ?? null,
            engineVersion: FUNDING_PROVENANCE_ENGINE_VERSION
          });
        }
      }
    }
  }

  return paths.sort((a, b) => b.pathScore - a.pathScore).slice(0, 10);
}
