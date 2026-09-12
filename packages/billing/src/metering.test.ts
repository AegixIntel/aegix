import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCatalog, freeEntitlements, type EntitlementBaseline } from "./catalog.js";
import {
  dimensionForUsageType,
  entitlementForDimension,
  isLevelDimension,
  summarizeUsage,
  usageTypesForDimension
} from "./metering.js";
import { addInterval, calendarMonth, dayWindow, daysInPeriod, periodFrom } from "./period.js";
import { USAGE_DIMENSIONS } from "./types.js";

const baseline: EntitlementBaseline = {
  analysisDaily: 10,
  compareDaily: 50,
  askDaily: 25,
  marketsDaily: 200,
  monitorsActive: 3,
  apiKeysActive: 10,
  webhooksActive: 5,
  apiDaily: 500
};

test("storage usage types map onto billing dimensions", () => {
  assert.equal(dimensionForUsageType("expensive_analysis"), "WALLET_ANALYSIS");
  assert.equal(dimensionForUsageType("comparison"), "COMPARISON");
  assert.equal(dimensionForUsageType("wallet_context"), "WALLET_CONTEXT");
  assert.equal(dimensionForUsageType("ask_aegix"), "ASK_AEGIX");
  assert.equal(dimensionForUsageType("ask_markets"), "ASK_AEGIX");
  assert.equal(dimensionForUsageType("markets"), "MARKETS");
});

test("a cache hit is never a billable dimension", () => {
  // D3-C §24: cached results consume no quota and must not reach an invoice.
  assert.equal(dimensionForUsageType("cache_hit"), null);
  assert.equal(dimensionForUsageType("unknown_future_type"), null);
});

test("both Ask AEGIX usage types roll up into one dimension", () => {
  assert.deepEqual(usageTypesForDimension("ASK_AEGIX").sort(), ["ask_aegix", "ask_markets"]);
});

test("wallet context is metered but bounded by a rate limit, not an entitlement", () => {
  assert.equal(entitlementForDimension("WALLET_CONTEXT"), null);
  assert.equal(entitlementForDimension("WALLET_ANALYSIS"), "analysis.daily");
  assert.equal(entitlementForDimension("API_CALLS"), "api.daily");
});

test("monitored wallets is a level, not an accumulation", () => {
  assert.equal(isLevelDimension("MONITORED_WALLETS"), true);
  assert.equal(isLevelDimension("WALLET_ANALYSIS"), false);
});

test("summarizeUsage reports the full sellable surface, including untouched dimensions", () => {
  const period = { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" };
  const summary = summarizeUsage(
    [
      { dimension: "WALLET_ANALYSIS", units: 12 },
      { dimension: "WALLET_ANALYSIS", units: 3 },
      { dimension: "MONITORED_WALLETS", units: 2 }
    ],
    freeEntitlements(baseline),
    period,
    USAGE_DIMENSIONS
  );

  assert.equal(summary.days, 30);
  assert.equal(summary.dimensions.length, USAGE_DIMENSIONS.length);

  const analysis = summary.dimensions.find((d) => d.dimension === "WALLET_ANALYSIS");
  assert.ok(analysis);
  assert.equal(analysis.units, 15);
  assert.equal(analysis.limit, 10);
  assert.equal(analysis.includedUnits, 300, "a daily cap times the days in the period");
  assert.equal(analysis.overageUnits, 0);

  const monitors = summary.dimensions.find((d) => d.dimension === "MONITORED_WALLETS");
  assert.ok(monitors);
  assert.equal(monitors.includedUnits, 3, "a level dimension is not multiplied by days");

  const context = summary.dimensions.find((d) => d.dimension === "WALLET_CONTEXT");
  assert.ok(context);
  assert.equal(context.limit, null);
  assert.equal(context.includedUnits, null);
  assert.equal(context.overageUnits, 0);
});

test("usage past the period allowance is reported as overage", () => {
  const period = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" };
  const summary = summarizeUsage(
    [{ dimension: "WALLET_ANALYSIS", units: 14 }],
    freeEntitlements(baseline),
    period,
    ["WALLET_ANALYSIS"]
  );
  assert.equal(summary.dimensions[0]?.includedUnits, 10);
  assert.equal(summary.dimensions[0]?.overageUnits, 4);
});

test("plan entitlements widen the period allowance", () => {
  const pro = buildPlanCatalog(baseline, "USD").find((plan) => plan.code === "pro");
  assert.ok(pro);
  const period = { start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" };
  const summary = summarizeUsage([{ dimension: "WALLET_ANALYSIS", units: 14 }], pro.entitlements, period, ["WALLET_ANALYSIS"]);
  assert.equal(summary.dimensions[0]?.includedUnits, 100);
  assert.equal(summary.dimensions[0]?.overageUnits, 0);
});

test("period boundaries are UTC and match the daily quota window", () => {
  const now = new Date("2026-09-13T23:30:00.000Z");
  assert.deepEqual(dayWindow(now), { start: "2026-09-13T00:00:00.000Z", end: "2026-09-14T00:00:00.000Z" });
  assert.deepEqual(calendarMonth(now), { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" });
});

test("month arithmetic clamps rather than overflowing", () => {
  assert.equal(addInterval(new Date("2026-01-31T00:00:00.000Z"), "MONTH").toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(addInterval(new Date("2028-01-31T00:00:00.000Z"), "MONTH").toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(addInterval(new Date("2026-12-15T00:00:00.000Z"), "MONTH").toISOString(), "2027-01-15T00:00:00.000Z");
  assert.equal(addInterval(new Date("2028-02-29T00:00:00.000Z"), "YEAR").toISOString(), "2029-02-28T00:00:00.000Z");
});

test("an interval-less plan reports the calendar month", () => {
  assert.deepEqual(periodFrom(new Date("2026-09-13T12:00:00.000Z"), "NONE"), calendarMonth(new Date("2026-09-13T12:00:00.000Z")));
});

test("daysInPeriod refuses to invent days for an inverted or unparsable period", () => {
  assert.equal(daysInPeriod({ start: "2026-10-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" }), 0);
  assert.equal(daysInPeriod({ start: "nope", end: "2026-09-01T00:00:00.000Z" }), 0);
});
