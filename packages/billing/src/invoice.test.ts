import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCatalog, findPlan, freeEntitlements, type EntitlementBaseline } from "./catalog.js";
import { computeInvoice } from "./invoice.js";
import { summarizeUsage } from "./metering.js";
import { USAGE_DIMENSIONS, type PlanDefinition } from "./types.js";

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

const catalog = buildPlanCatalog(baseline, "USD");
const free = findPlan(catalog, "free") as PlanDefinition;
const pro = findPlan(catalog, "pro") as PlanDefinition;
const period = { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" };

function usageFor(plan: PlanDefinition, units: number) {
  return summarizeUsage([{ dimension: "WALLET_ANALYSIS", units }], plan.entitlements, period, USAGE_DIMENSIONS);
}

test("a free plan invoice has no lines and no total", () => {
  const invoice = computeInvoice(free, usageFor(free, 5));
  assert.deepEqual(invoice.lines, []);
  assert.equal(invoice.subtotalCents, 0);
  assert.equal(invoice.totalCents, 0);
});

test("a paid plan invoice is exactly one subscription line under the v1 catalog", () => {
  const invoice = computeInvoice(pro, usageFor(pro, 4000));
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0]?.kind, "SUBSCRIPTION");
  assert.equal(invoice.lines[0]?.amountCents, 4900);
  assert.equal(invoice.totalCents, 4900);
  assert.equal(invoice.currency, "USD");
  assert.equal(invoice.periodStart, period.start);
  assert.equal(invoice.periodEnd, period.end);
});

test("computing the same invoice twice produces the same result", () => {
  const first = computeInvoice(pro, usageFor(pro, 17));
  const second = computeInvoice(pro, usageFor(pro, 17));
  assert.deepEqual(first, second);
});

test("a plan that declares overage pricing charges only the units past the allowance", () => {
  const metered: PlanDefinition = { ...pro, overageCents: { WALLET_ANALYSIS: 3 } };
  // 100/day x 30 days = 3000 included; 3050 used leaves 50 overage units.
  const invoice = computeInvoice(metered, usageFor(metered, 3050));
  assert.equal(invoice.lines.length, 2);
  const overage = invoice.lines.find((line) => line.kind === "OVERAGE");
  assert.ok(overage);
  assert.equal(overage.dimension, "WALLET_ANALYSIS");
  assert.equal(overage.quantity, 50);
  assert.equal(overage.unitCents, 3);
  assert.equal(overage.amountCents, 150);
  assert.equal(invoice.totalCents, 5050);
});

test("usage inside the allowance produces no overage line", () => {
  const metered: PlanDefinition = { ...pro, overageCents: { WALLET_ANALYSIS: 3 } };
  const invoice = computeInvoice(metered, usageFor(metered, 3000));
  assert.equal(invoice.lines.filter((line) => line.kind === "OVERAGE").length, 0);
});

test("a zero overage rate is not a charge", () => {
  const metered: PlanDefinition = { ...pro, overageCents: { WALLET_ANALYSIS: 0 } };
  const invoice = computeInvoice(metered, usageFor(metered, 9999));
  assert.equal(invoice.lines.length, 1);
});

test("amounts stay integer cents", () => {
  const metered: PlanDefinition = { ...pro, overageCents: { WALLET_ANALYSIS: 7 } };
  const invoice = computeInvoice(metered, usageFor(metered, 3003));
  for (const line of invoice.lines) assert.equal(Number.isInteger(line.amountCents), true);
  assert.equal(Number.isInteger(invoice.totalCents), true);
});

test("an unmetered dimension never reaches an invoice", () => {
  const metered: PlanDefinition = { ...free, overageCents: { WALLET_CONTEXT: 5 } };
  const usage = summarizeUsage(
    [{ dimension: "WALLET_CONTEXT", units: 10_000 }],
    freeEntitlements(baseline),
    period,
    USAGE_DIMENSIONS
  );
  assert.deepEqual(computeInvoice(metered, usage).lines, []);
});
