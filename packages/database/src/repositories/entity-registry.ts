import type { Sql } from "../client.js";

export interface EntitySeedRow {
  id: string;
  name: string;
  entity_type: string;
  status: string;
  default_confidence: number;
  source_type: string;
}

export interface EntityAddressSeedRow {
  id: string;
  entity_id: string;
  chain: string;
  address: string;
  label: string | null;
  confidence: number;
  evidence_source: string | null;
  status: string;
}

export interface EntityRegistryRepo {
  listEntities(): Promise<EntitySeedRow[]>;
  listAddresses(): Promise<EntityAddressSeedRow[]>;
  upsertEntity(input: {
    name: string;
    entityType: string;
    description: string | null;
    status: string;
    defaultConfidence: number;
    sourceType: string;
  }): Promise<EntitySeedRow>;
  upsertAddress(input: {
    entityId: string;
    chain: string;
    address: string;
    label: string | null;
    confidence: number;
    evidenceSource: string | null;
    status: string;
  }): Promise<EntityAddressSeedRow>;
  findAddressesByChain(chain: string): Promise<EntityAddressSeedRow[]>;
}

/** Entity registry repository, see architecture.md §17-§18, §36-§37. */
export function createEntityRegistryRepo(sql: Sql): EntityRegistryRepo {
  return {
    async listEntities() {
      return sql<EntitySeedRow[]>`select * from entities order by name`;
    },

    async listAddresses() {
      return sql<EntityAddressSeedRow[]>`select * from entity_addresses order by address`;
    },

    async upsertEntity(input) {
      const [row] = await sql<EntitySeedRow[]>`
        insert into entities (name, entity_type, description, status, default_confidence, source_type)
        values (${input.name}, ${input.entityType}, ${input.description}, ${input.status}, ${input.defaultConfidence}, ${input.sourceType})
        on conflict (name) do update set
          entity_type = excluded.entity_type,
          description = excluded.description,
          status = excluded.status,
          default_confidence = excluded.default_confidence,
          source_type = excluded.source_type,
          updated_at = now()
        returning *
      `;
      if (!row) throw new Error("entity upsert returned no row");
      return row;
    },

    async upsertAddress(input) {
      const [row] = await sql<EntityAddressSeedRow[]>`
        insert into entity_addresses (entity_id, chain, address, label, confidence, evidence_source, status)
        values (${input.entityId}, ${input.chain}, ${input.address}, ${input.label}, ${input.confidence}, ${input.evidenceSource}, ${input.status})
        on conflict (chain, address) do update set
          entity_id = excluded.entity_id,
          label = excluded.label,
          confidence = excluded.confidence,
          evidence_source = excluded.evidence_source,
          status = excluded.status,
          last_verified_at = now()
        returning *
      `;
      if (!row) throw new Error("entity address upsert returned no row");
      return row;
    },

    async findAddressesByChain(chain) {
      return sql<EntityAddressSeedRow[]>`
        select * from entity_addresses where chain = ${chain} and status != 'DEPRECATED'
      `;
    }
  };
}
