import type { Entity, EntityAddress, EntityMatch, IntelligenceSignal, NormalizedProgramInteraction, NormalizedTransfer } from "@aegix/types";
import { makeSignal } from "../signals.js";

export const ENTITY_ENGINE_VERSION = "entity-v1.0.0";

export interface EntityRegistry {
  entities: Entity[];
  addresses: EntityAddress[];
}

export interface EntityAnalysisInput {
  walletAddress: string;
  transfers: NormalizedTransfer[];
  interactions: NormalizedProgramInteraction[];
  registry: EntityRegistry;
}

export interface EntityAnalysisResult {
  signals: IntelligenceSignal[];
  matches: EntityMatch[];
  interactionCounts: Map<string, number>;
}

/**
 * Entity matching engine, see architecture.md §54 (entity exposure) and §36-§37.
 * Matches wallet counterparties and interacted programs against a curated registry.
 */
export function analyzeEntities(input: EntityAnalysisInput): EntityAnalysisResult {
  const { walletAddress, transfers, interactions, registry } = input;

  const addressToEntity = new Map<string, EntityAddress>();
  for (const addr of registry.addresses) {
    addressToEntity.set(addr.address, addr);
  }

  const entityInteractionCounts = new Map<string, number>();
  const matches: EntityMatch[] = [];
  const seen = new Set<string>();

  const consider = (address: string) => {
    if (seen.has(address)) return;
    seen.add(address);
    const entityAddress = addressToEntity.get(address);
    if (!entityAddress) return;
    const entity = registry.entities.find((e) => e.id === entityAddress.entityId);
    if (!entity) return;
    matches.push({ entity, address, confidence: entityAddress.confidence });
  };

  for (const t of transfers) {
    if (t.fromAddress === walletAddress) consider(t.toAddress);
    if (t.toAddress === walletAddress) consider(t.fromAddress);
  }

  for (const ix of interactions) {
    consider(ix.programId);
  }

  // Count interactions per matched entity from program interactions
  for (const ix of interactions) {
    const entityAddress = addressToEntity.get(ix.programId);
    if (!entityAddress) continue;
    const entity = registry.entities.find((e) => e.id === entityAddress.entityId);
    if (!entity) continue;
    entityInteractionCounts.set(entity.id, (entityInteractionCounts.get(entity.id) ?? 0) + 1);
  }

  const signals: IntelligenceSignal[] = [];
  for (const match of matches) {
    const count = entityInteractionCounts.get(match.entity.id) ?? 0;
    signals.push(
      makeSignal(
        {
          type: "KNOWN_ENTITY_INTERACTION",
          category: "ENTITY",
          severity: match.entity.entityType === "CENTRALIZED_EXCHANGE" ? 65 : 50,
          confidence: match.confidence,
          title: `Interaction with ${match.entity.name}`,
          summary: `This wallet interacted with known entity ${match.entity.name} (${match.entity.entityType}).`,
          evidence: [
            { key: "entity", value: match.entity.name, label: "Entity" },
            { key: "entity_type", value: match.entity.entityType, label: "Type" },
            { key: "interaction_count", value: count, label: "Interactions" }
          ]
        },
        ENTITY_ENGINE_VERSION
      )
    );
  }

  return { signals, matches, interactionCounts: entityInteractionCounts };
}
