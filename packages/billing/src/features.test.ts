import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTITLEMENT_KEYS, PLAN_CODES } from "./types.js";
import { FEATURE_KEYS, FEATURE_REGISTRY, canUseFeature, featureQuotaKey, isFeatureKey } from "./features.js";

test("the registry covers every product surface exactly once", () => {
  assert.deepEqual([...FEATURE_KEYS].sort(), [
    "API_KEYS",
    "ASK_AEGIX",
    "ATTACK_MY_WALLET",
    "COMPARE",
    "DEVELOPER_API",
    "MARKETS",
    "MONITOR",
    "SAVED_ANALYSES",
    "SAVED_COMPARISONS",
    "WALLET_CONTEXT",
    "WALLET_XRAY",
    "WEBHOOKS"
  ]);
  assert.equal(new Set(FEATURE_KEYS).size, FEATURE_KEYS.length);
  for (const key of FEATURE_KEYS) assert.equal(FEATURE_REGISTRY[key].key, key);
});

test("every v1 plan includes every feature: plans differ only in quota", () => {
  for (const plan of PLAN_CODES) {
    for (const key of FEATURE_KEYS) assert.equal(canUseFeature(plan, key), true, `${plan} includes ${key}`);
  }
});

test("metered features point at the entitlement that bounds them; unmetered ones at none", () => {
  assert.deepEqual(Object.fromEntries(FEATURE_KEYS.map((key) => [key, featureQuotaKey(key)])), {
    WALLET_XRAY: "analysis.daily",
    ATTACK_MY_WALLET: "analysis.daily",
    WALLET_CONTEXT: null,
    COMPARE: "compare.daily",
    MONITOR: "monitors.active",
    ASK_AEGIX: "ask.daily",
    MARKETS: "markets.daily",
    SAVED_ANALYSES: null,
    SAVED_COMPARISONS: null,
    DEVELOPER_API: "api.daily",
    API_KEYS: "apiKeys.active",
    WEBHOOKS: "webhooks.active"
  });
});

test("every entitlement key bounds at least one registered feature", () => {
  const bounded = new Set(FEATURE_KEYS.map(featureQuotaKey).filter((key) => key !== null));
  for (const key of ENTITLEMENT_KEYS) assert.ok(bounded.has(key), `${key} bounds a feature`);
});

test("isFeatureKey accepts registered features only", () => {
  assert.equal(isFeatureKey("MONITOR"), true);
  assert.equal(isFeatureKey("monitor"), false);
  assert.equal(isFeatureKey("pro"), false);
  assert.equal(isFeatureKey("MULTI_CHAIN"), false);
});
