/**
 * Entity registry seed v1, see architecture.md §17, §36-§37 and milestone Phase 9.
 *
 * Seeds ONLY protocol program IDs that are publicly documented and stable.
 * Exchange wallet addresses are deliberately NOT seeded — weak attribution
 * must never become fact.
 *
 * Usage: pnpm --filter @aegix/database seed:entities
 */

import postgres from "postgres";
import { createEntityRegistryRepo } from "./repositories/entity-registry.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/aegix";

interface SeedEntry {
  name: string;
  entityType: string;
  description: string;
  status: "VERIFIED" | "PROBABLE";
  confidence: number;
  sourceType: string;
  addresses: Array<{
    address: string;
    label: string;
    confidence: number;
    status: "VERIFIED" | "PROBABLE";
    evidenceSource: string;
  }>;
}

/** Program IDs are protocol-owned accounts; treat as VERIFIED with high confidence. */
const SEED_ENTITIES: SeedEntry[] = [
  {
    name: "Jupiter",
    entityType: "DEX",
    description: "Jupiter Aggregator v6 — Solana's primary DEX aggregator.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        label: "Jupiter Aggregator v6",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://jup.ag/docs"
      }
    ]
  },
  {
    name: "Raydium AMM",
    entityType: "DEX",
    description: "Raydium AMM pool program.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6",
        label: "Raydium AMM",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://raydium.io"
      },
      {
        address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
        label: "Raydium Concentrated Liquidity",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://raydium.io"
      }
    ]
  },
  {
    name: "Pump.fun",
    entityType: "PROTOCOL",
    description: "Pump.fun meme token launchpad.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        label: "Pump.fun",
        confidence: 0.95,
        status: "VERIFIED",
        evidenceSource: "https://pump.fun"
      }
    ]
  },
  {
    name: "Kamino",
    entityType: "LENDING",
    description: "Kamino lending protocol.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw",
        label: "Kamino Lending",
        confidence: 0.95,
        status: "VERIFIED",
        evidenceSource: "https://app.kamino.finance"
      }
    ]
  },
  {
    name: "Drift",
    entityType: "LENDING",
    description: "Drift perpetuals / lending protocol.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF",
        label: "Drift",
        confidence: 0.95,
        status: "VERIFIED",
        evidenceSource: "https://www.drift.trade"
      }
    ]
  },
  {
    name: "OpenBook",
    entityType: "DEX",
    description: "OpenBook central limit order book.",
    status: "PROBABLE",
    confidence: 0.9,
    sourceType: "COMMUNITY_DOCUMENTATION",
    addresses: [
      {
        address: "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
        label: "OpenBook",
        confidence: 0.9,
        status: "PROBABLE",
        evidenceSource: "https://github.com/openbook-dex"
      }
    ]
  }
];

async function run(): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const repo = createEntityRegistryRepo(sql);

  let entities = 0;
  let addresses = 0;

  for (const seed of SEED_ENTITIES) {
    const entity = await repo.upsertEntity({
      name: seed.name,
      entityType: seed.entityType,
      description: seed.description,
      status: seed.status,
      defaultConfidence: seed.confidence,
      sourceType: seed.sourceType
    });
    entities += 1;

    for (const addr of seed.addresses) {
      await repo.upsertAddress({
        entityId: entity.id,
        chain: "solana",
        address: addr.address,
        label: addr.label,
        confidence: addr.confidence,
        evidenceSource: addr.evidenceSource,
        status: addr.status
      });
      addresses += 1;
    }
  }

  console.log(`seeded ${entities} entities, ${addresses} addresses`);
  await sql.end();
}

run().catch((err) => {
  console.error("entity seed failed:", err);
  process.exitCode = 1;
});
