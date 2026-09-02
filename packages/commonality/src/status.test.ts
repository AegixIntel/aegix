/**
 * D6-I2 unit tests for commonalityStatus: the feature flag is NOT the same
 * as the penalty being active — population data only applies when the
 * aggregation exists, is large enough, and is fresh enough.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { commonalityStatus, type CommonalityContext } from "./index.js";

/** Tagged-template SQL stub: routes to canned rows based on the SQL text. */
function fakeCtx(overrides: { populationSize?: number; lastAggregationAt?: string | null }): CommonalityContext {
  const { populationSize = 0, lastAggregationAt = null } = overrides;
  const sql = ((strings: TemplateStringsArray, ..._args: unknown[]) => {
    const sqlText = strings.join("?");
    if (sqlText.includes("population_contribution_state") && sqlText.includes("count(*)")) {
      return Promise.resolve([{ count: String(populationSize) }]);
    }
    if (sqlText.includes("max(contributed_at)")) {
      return Promise.resolve([{ at: lastAggregationAt }]);
    }
    return Promise.resolve([]);
  }) as unknown as CommonalityContext["sql"];
  return { sql };
}

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const fresh = new Date(Date.now() - 3600_000).toISOString(); // 1h old
const stale = new Date(Date.now() - 400 * 3600_000).toISOString(); // 400h old

test("commonalityStatus: disabled → STATIC, not eligible", async () => {
  const status = await commonalityStatus(fakeCtx({ populationSize: 500, lastAggregationAt: fresh }), { enabled: false });
  assert.equal(status.eligible, false);
  assert.equal(status.source, "STATIC");
  assert.match(status.reason, /disabled/);
});

test("commonalityStatus: no aggregation → FALLBACK, not eligible", async () => {
  const status = await commonalityStatus(fakeCtx({ populationSize: 0, lastAggregationAt: null }), {
    enabled: true,
    minPopulation: 20,
    maxSnapshotAgeHours: 336
  });
  assert.equal(status.eligible, false);
  assert.equal(status.source, "FALLBACK");
  assert.match(status.reason, /no population aggregation/);
});

test("commonalityStatus: population below minimum → FALLBACK", async () => {
  const status = await commonalityStatus(fakeCtx({ populationSize: 12, lastAggregationAt: fresh }), {
    enabled: true,
    minPopulation: 20,
    maxSnapshotAgeHours: 336
  });
  assert.equal(status.eligible, false);
  assert.equal(status.source, "FALLBACK");
  assert.match(status.reason, /population too small/);
});

test("commonalityStatus: stale snapshot → FALLBACK with stale flag", async () => {
  const status = await commonalityStatus(fakeCtx({ populationSize: 100, lastAggregationAt: stale }), {
    enabled: true,
    minPopulation: 20,
    maxSnapshotAgeHours: 336
  });
  assert.equal(status.eligible, false);
  assert.equal(status.source, "FALLBACK");
  assert.equal(status.stale, true);
  assert.ok((status.snapshotAgeHours ?? 0) > 336);
});

test("commonalityStatus: large + fresh population → POPULATION, eligible", async () => {
  const status = await commonalityStatus(fakeCtx({ populationSize: 100, lastAggregationAt: fresh }), {
    enabled: true,
    minPopulation: 20,
    maxSnapshotAgeHours: 336
  });
  assert.equal(status.eligible, true);
  assert.equal(status.source, "POPULATION");
  assert.equal(status.populationSize, 100);
  assert.equal(status.stale, false);
  assert.ok((status.snapshotAgeHours ?? 99) < 2);
});

test("commonalityStatus: exactly at minimum → eligible", async () => {
  const status = await commonalityStatus(fakeCtx({ populationSize: 20, lastAggregationAt: fresh }), {
    enabled: true,
    minPopulation: 20,
    maxSnapshotAgeHours: 336
  });
  assert.equal(status.eligible, true);
  assert.equal(status.source, "POPULATION");
});
