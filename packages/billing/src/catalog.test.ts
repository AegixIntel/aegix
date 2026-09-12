import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlanCatalog, catalogViolations, findPlan, freeEntitlements, type EntitlementBaseline } from "./catalog.js";
import { ENTITLEMENT_KEYS, PLAN_CATALOG_VERSION } from "./types.js";

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

test("the free plan is the deployment baseline, entitlement for entitlement", () => {
  const catalog = buildPlanCatalog(baseline, "USD");
  const free = findPlan(catalog, "free");
  assert.ok(free);
  assert.deepEqual(free.entitlements, freeEntitlements(baseline));
  assert.equal(free.priceCents, 0);
  assert.equal(free.interval, "NONE");
});

test("paid plans scale the baseline by family", () => {
  const catalog = buildPlanCatalog(baseline, "USD");
  const pro = findPlan(catalog, "pro");
  const team = findPlan(catalog, "team");
  assert.ok(pro && team);
  // DAILY x10 / x40, LEVEL x5 / x20.
  assert.equal(pro.entitlements["analysis.daily"], 100);
  assert.equal(pro.entitlements["monitors.active"], 15);
  assert.equal(team.entitlements["analysis.daily"], 400);
  assert.equal(team.entitlements["monitors.active"], 60);
});

test("a surface switched off for the deployment stays off on every plan", () => {
  const catalog = buildPlanCatalog({ ...baseline, marketsDaily: 0, webhooksActive: 0 }, "USD");
  for (const plan of catalog) {
    assert.equal(plan.entitlements["markets.daily"], 0, plan.code);
    assert.equal(plan.entitlements["webhooks.active"], 0, plan.code);
  }
});

test("catalog is monotonic: a higher tier never grants less", () => {
  assert.deepEqual(catalogViolations(buildPlanCatalog(baseline, "USD")), []);
});

test("catalogViolations reports a non-monotonic catalog", () => {
  const catalog = buildPlanCatalog(baseline, "USD");
  const pro = findPlan(catalog, "pro");
  assert.ok(pro);
  const broken = catalog.map((plan) =>
    plan.code === "pro" ? { ...plan, entitlements: { ...plan.entitlements, "analysis.daily": 1 } } : plan
  );
  const problems = catalogViolations(broken);
  assert.deepEqual(problems, ["pro.analysis.daily (1) is below free (10)"]);
});

test("every entitlement key is present on every plan", () => {
  for (const plan of buildPlanCatalog(baseline, "USD")) {
    for (const key of ENTITLEMENT_KEYS) {
      assert.equal(typeof plan.entitlements[key], "number", `${plan.code}.${key}`);
    }
    assert.equal(plan.catalogVersion, PLAN_CATALOG_VERSION);
    assert.equal(plan.currency, "USD");
    assert.deepEqual(plan.overageCents, {}, "v1 ships hard caps, no overage pricing");
  }
});

test("findPlan returns null for an unknown code", () => {
  assert.equal(findPlan(buildPlanCatalog(baseline, "USD"), "enterprise"), null);
});
