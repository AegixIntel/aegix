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

export interface SeedEntry {
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
  },
  {
    name: "Magic Eden",
    entityType: "NFT_MARKETPLACE",
    description: "Magic Eden v2 — Solana NFT marketplace.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K",
        label: "Magic Eden v2",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://magiceden.io"
      }
    ]
  },
  {
    name: "Metaplex",
    entityType: "NFT_MARKETPLACE",
    description: "Metaplex Token Metadata — the standard for NFT metadata on Solana.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
        label: "Metaplex Token Metadata",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://docs.metaplex.com"
      }
    ]
  },
  {
    name: "Orca",
    entityType: "DEX",
    description: "Orca — concentrated liquidity DEX on Solana.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
        label: "Orca v1",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://docs.orca.so"
      },
      {
        address: "whirLbMiicVdio4qvUfM5KAg6Ct8VdjYdZyBf5byvVM",
        label: "Orca Whirlpools",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://docs.orca.so"
      }
    ]
  },
  {
    name: "Meteora",
    entityType: "DEX",
    description: "Meteora — dynamic liquidity pools on Solana.",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
        label: "Meteora DLMM",
        confidence: 0.95,
        status: "VERIFIED",
        evidenceSource: "https://docs.meteora.ag"
      }
    ]
  },
  {
    name: "Marinade",
    entityType: "STAKING",
    description: "Marinade — liquid staking protocol on Solana.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
        label: "Marinade Finance",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://docs.marinade.finance"
      }
    ]
  },
  {
    name: "Wormhole",
    entityType: "BRIDGE",
    description: "Wormhole — cross-chain bridge protocol.",
    status: "VERIFIED",
    confidence: 0.98,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
        label: "Wormhole",
        confidence: 0.98,
        status: "VERIFIED",
        evidenceSource: "https://docs.wormhole.com"
      }
    ]
  }
];

/**
 * Validates the seed registry before loading, see milestone D2 Phase 11.
 * Invalid seeds must fail loudly at load time — never silently skip.
 * Returns a list of problems; an empty list means the registry is valid.
 */
export function validateSeedEntries(entries: SeedEntry[]): string[] {
  const problems: string[] = [];
  const seenAddresses = new Map<string, string>(); // address -> entity name
  const validStatuses = new Set(["VERIFIED", "PROBABLE", "UNVERIFIED"]);

  for (const entry of entries) {
    if (!entry.name || entry.name.trim().length === 0) {
      problems.push("entity with empty name");
    }
    if (!validStatuses.has(entry.status)) {
      problems.push(`${entry.name}: invalid status "${entry.status}"`);
    }
    if (typeof entry.confidence !== "number" || entry.confidence < 0 || entry.confidence > 1) {
      problems.push(`${entry.name}: confidence ${entry.confidence} out of range [0,1]`);
    }
    if (!entry.sourceType || entry.sourceType.trim().length === 0) {
      problems.push(`${entry.name}: missing sourceType`);
    }
    if (!entry.addresses || entry.addresses.length === 0) {
      problems.push(`${entry.name}: no addresses`);
      continue;
    }

    for (const addr of entry.addresses) {
      if (!isValidBase58Address(addr.address)) {
        problems.push(`${entry.name}: invalid Solana address "${addr.address.slice(0, 12)}…"`);
      }
      if (!validStatuses.has(addr.status)) {
        problems.push(`${entry.name}/${addr.label}: invalid status "${addr.status}"`);
      }
      if (typeof addr.confidence !== "number" || addr.confidence < 0 || addr.confidence > 1) {
        problems.push(`${entry.name}/${addr.label}: confidence ${addr.confidence} out of range [0,1]`);
      }
      if (!addr.evidenceSource || addr.evidenceSource.trim().length === 0) {
        problems.push(`${entry.name}/${addr.label}: missing evidenceSource`);
      }

      const existing = seenAddresses.get(addr.address);
      if (existing) {
        if (existing !== entry.name) {
          problems.push(`address ${addr.address.slice(0, 12)}… claimed by both "${existing}" and "${entry.name}"`);
        }
      } else {
        seenAddresses.set(addr.address, entry.name);
      }
    }
  }

  return problems;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 check: valid chars only + length in the Solana address range. */
function isValidBase58Address(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false;
  for (const ch of address) {
    if (!BASE58_ALPHABET.includes(ch)) return false;
  }
  return true;
}

async function run(): Promise<void> {
  const problems = validateSeedEntries(SEED_ENTITIES);
  if (problems.length > 0) {
    console.error("entity seed validation FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

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

// Only run the seed when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error("entity seed failed:", err);
    process.exitCode = 1;
  });
}
