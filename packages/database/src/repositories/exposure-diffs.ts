import type { Sql } from "../client.js";

/** postgres.js JSON payload — the repo boundary accepts plain JSON values. */
type JsonInput =
  | null
  | string
  | number
  | boolean
  | JsonInput[]
  | { [key: string]: JsonInput | undefined };

export interface ExposureDiffRow {
  id: string;
  monitor_id: string;
  previous_analysis_id: string;
  current_analysis_id: string;
  overall_change: unknown;
  dimension_changes: unknown;
  new_signals: unknown;
  removed_signals: unknown;
  changed_signals: unknown;
  entity_changes: unknown;
  relationship_changes: unknown;
  behavior_changes: unknown;
  attack_path_changes: unknown;
  data_quality_change: unknown;
  comparability: unknown;
  confidence: string;
  diff_version: string;
  created_at: string;
}

export interface ExposureDiffRepo {
  /** Idempotent: unique (monitor, prev, current) — returns existing row on conflict. */
  insert(input: {
    monitorId: string;
    previousAnalysisId: string;
    currentAnalysisId: string;
    diff: Record<string, unknown>;
  }): Promise<{ row: ExposureDiffRow; created: boolean }>;
  getById(id: string): Promise<ExposureDiffRow | null>;
  listForMonitor(monitorId: string, limit: number): Promise<ExposureDiffRow[]>;
}

/** Casts an arbitrary JSON-ish value for sql.json(...), see client.ts JsonValue. */
function jsonValue(value: unknown): JsonInput {
  return value as JsonInput;
}

/** Exposure diff persistence, see docs/milestone-d4.md (D4-C §33). */
export function createExposureDiffRepo(sql: Sql): ExposureDiffRepo {
  return {
    async insert(input) {
      const [row] = await sql<ExposureDiffRow[]>`
        insert into exposure_diffs (
          monitor_id, previous_analysis_id, current_analysis_id,
          overall_change, dimension_changes, new_signals, removed_signals,
          changed_signals, entity_changes, relationship_changes,
          behavior_changes, attack_path_changes, data_quality_change,
          comparability, confidence, diff_version
        )
        values (
          ${input.monitorId}, ${input.previousAnalysisId}, ${input.currentAnalysisId},
          ${sql.json(jsonValue(input.diff.overallChange ?? {}))},
          ${sql.json(jsonValue(input.diff.dimensionChanges ?? []))},
          ${sql.json(jsonValue(input.diff.newSignals ?? []))},
          ${sql.json(jsonValue(input.diff.removedSignals ?? []))},
          ${sql.json(jsonValue(input.diff.changedSignals ?? []))},
          ${sql.json(jsonValue(input.diff.entityChanges ?? []))},
          ${sql.json(jsonValue(input.diff.relationshipChanges ?? []))},
          ${sql.json(jsonValue(input.diff.behaviorChanges ?? []))},
          ${sql.json(jsonValue(input.diff.attackPathChanges ?? []))},
          ${sql.json(jsonValue(input.diff.dataQualityChange ?? {}))},
          ${sql.json(jsonValue(input.diff.comparability ?? {}))},
          ${Number(input.diff.confidence ?? 0)},
          ${String(input.diff.diffVersion ?? "")}
        )
        on conflict (monitor_id, previous_analysis_id, current_analysis_id) do nothing
        returning *
      `;
      if (row) return { row, created: true };
      const [existing] = await sql<ExposureDiffRow[]>`
        select * from exposure_diffs
        where monitor_id = ${input.monitorId}
          and previous_analysis_id = ${input.previousAnalysisId}
          and current_analysis_id = ${input.currentAnalysisId}
        limit 1
      `;
      if (!existing) throw new Error("exposure diff conflict returned no row");
      return { row: existing, created: false };
    },

    async getById(id) {
      const [row] = await sql<ExposureDiffRow[]>`
        select * from exposure_diffs where id = ${id}
      `;
      return row ?? null;
    },

    async listForMonitor(monitorId, limit) {
      return sql<ExposureDiffRow[]>`
        select * from exposure_diffs
        where monitor_id = ${monitorId}
        order by created_at desc
        limit ${limit}
      `;
    }
  };
}
