/**
 * Rolling storage counters up into billing dimensions.
 *
 * Pure on purpose: the API and the worker's lifecycle sweep both need this
 * mapping, and if each did its own the invoice a customer sees could differ
 * from the usage the dashboard shows. Callers fetch their own rows; this
 * decides what those rows mean.
 */

import { dimensionForUsageType } from "./metering.js";
import type { MeteredUsage } from "./types.js";

export interface UsageRecordTotal {
  usage_type: string;
  units: number;
}

export interface RollupInput {
  /** Per-usage_type totals from usage_records for the period. */
  records: readonly UsageRecordTotal[];
  /** Successful developer API units for the period (developer_usage_events). */
  apiUnits: number;
  /** Active monitors right now — a level, not an accumulation. */
  activeMonitors: number;
}

export function rollUpUsage(input: RollupInput): MeteredUsage[] {
  const usage: MeteredUsage[] = [];
  for (const record of input.records) {
    const dimension = dimensionForUsageType(record.usage_type);
    // An unmapped usage_type is not billable. `cache_hit` in particular must
    // never be counted as work (D3-C §24).
    if (dimension) usage.push({ dimension, units: record.units });
  }
  usage.push({ dimension: "API_CALLS", units: input.apiUnits });
  usage.push({ dimension: "MONITORED_WALLETS", units: input.activeMonitors });
  return usage;
}
