/**
 * Entity registry seed, see architecture.md §17, §36-§37 and milestone Phase 9.
 *
 * Entries are derived from the canonical program catalog in `@aegix/types`,
 * which is the single source of truth for every program identity AEGIX
 * claims. This file used to hold its own copy of the addresses; four of them
 * pointed at accounts that do not exist on mainnet, so those protocols were
 * never recognized in any analysis.
 *
 * Seeds ONLY protocol program IDs that are publicly documented and stable.
 * Infrastructure programs (memo, compression, oracles) are parsed but not
 * seeded: every wallet touches them, so they carry no attribution value.
 * Exchange wallet addresses are deliberately NOT seeded — weak attribution
 * must never become fact.
 *
 * Usage: pnpm --filter @aegix/database seed:entities
 */

import { SEEDABLE_ENTITIES, base58ByteLength } from "@aegix/types";
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
    /** D5-F §22: role of this address within the entity. */
    role?: "PROGRAM" | "ROUTER" | "TREASURY" | "VAULT" | "HOT_WALLET" | "DEPOSIT" | "ESCROW" | "UNKNOWN_ROLE";
    /** D5-F §26: deprecation reason; the address stays for reproducibility. */
    deprecatedReason?: string;
  }>;
}

/**
 * Program IDs are protocol-owned accounts. Derived from the canonical
 * catalog so an address is written down exactly once in the codebase.
 */
export const SEED_ENTITIES: SeedEntry[] = SEEDABLE_ENTITIES.map((entity) => ({
  name: entity.name,
  entityType: entity.entityType,
  description: entity.description,
  status: entity.status,
  confidence: entity.confidence,
  sourceType: entity.sourceType,
  addresses: entity.programs.map((program) => ({
    address: program.programId,
    label: program.label,
    confidence: program.confidence,
    status: program.status,
    evidenceSource: program.evidenceSource,
    role: program.role,
    deprecatedReason: program.deprecatedReason
  }))
}));

/**
 * Validates the seed registry before loading, see milestone D2 Phase 11.
 * Invalid seeds must fail loudly at load time — never silently skip.
 * Returns a list of problems; an empty list means the registry is valid.
 */
export function validateSeedEntries(entries: SeedEntry[]): string[] {
  const problems: string[] = [];
  const seenAddresses = new Map<string, string>(); // address -> entity name
  const validStatuses = new Set(["VERIFIED", "PROBABLE", "UNVERIFIED"]);
  const validRoles = new Set(["PROGRAM", "ROUTER", "TREASURY", "VAULT", "HOT_WALLET", "DEPOSIT", "ESCROW", "UNKNOWN_ROLE"]);

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
      // D5-F §23: verified provenance is mandatory — a VERIFIED address
      // without a documented source must fail loudly, never silently load.
      if (addr.status === "VERIFIED" && (!addr.evidenceSource || addr.evidenceSource.trim().length === 0)) {
        problems.push(`${entry.name}/${addr.label}: VERIFIED address missing evidenceSource`);
      }
      if (addr.role && !validRoles.has(addr.role)) {
        problems.push(`${entry.name}/${addr.label}: invalid role "${addr.role}"`);
      }
      // D5-F §26: deprecation must carry a reason (reproducibility, not silence).
      if (addr.deprecatedReason && addr.status === "VERIFIED") {
        problems.push(`${entry.name}/${addr.label}: deprecated address cannot be VERIFIED`);
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

/**
 * A Solana public key is exactly 32 bytes. The previous check only looked at
 * the character set and the string length, which accepts strings that decode
 * to 31 bytes — exactly how an unusable Tensor program ID survived review.
 */
function isValidBase58Address(address: string): boolean {
  return base58ByteLength(address) === 32;
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
        status: addr.deprecatedReason ? "DEPRECATED" : addr.status,
        addressRole: addr.role,
        notes: addr.deprecatedReason ?? null
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
