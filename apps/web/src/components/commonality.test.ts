/**
 * D6-I3 UI-logic tests: commonality copy + treatment labels. The compare UI
 * renders these as mobile-friendly cards (no horizontal tables); the pure
 * functions are tested here without a DOM. Disclaimer presence + epistemic
 * safety are asserted at the copy level.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { commonalityLabel, commonalityFrequencyLabel, commonalityWhy } from "./compare-page";

test("commonalityLabel: treatment labels are epistemic-safe", () => {
  assert.equal(commonalityLabel("MEANINGFUL"), "MEANINGFUL");
  assert.equal(commonalityLabel("DISCOUNTED"), "DISCOUNTED");
  assert.equal(commonalityLabel("HEAVILY_DISCOUNTED"), "HEAVILY DISCOUNTED");
  assert.equal(commonalityLabel("STATIC"), "STATIC TREATMENT");
  // Labels never claim ownership/identity.
  for (const t of ["MEANINGFUL", "DISCOUNTED", "HEAVILY_DISCOUNTED", "STATIC"] as const) {
    const label = commonalityLabel(t);
    assert.ok(!/owner|identity|same person/i.test(label));
  }
});

test("commonalityFrequencyLabel: population percentages + small-sample fallback", () => {
  const withFreq = commonalityFrequencyLabel({ frequency: 0.68, populationSize: 250, treatment: "HEAVILY_DISCOUNTED" });
  assert.match(withFreq, /68% of eligible AEGIX-analyzed wallets/);
  assert.match(withFreq, /250 wallets/);

  const noFreq = commonalityFrequencyLabel({ frequency: null, populationSize: null, treatment: "STATIC" });
  assert.match(noFreq, /Not enough AEGIX-observed population/);
});

test("commonalityWhy: common hub vs rare counterparty vs static fallback", () => {
  const common = commonalityWhy({ treatment: "HEAVILY_DISCOUNTED", kind: "COUNTERPARTY" });
  assert.match(common, /common across the observed AEGIX population/);
  assert.ok(!/owner|identity/i.test(common));

  const commonEntity = commonalityWhy({ treatment: "DISCOUNTED", kind: "ENTITY" });
  assert.match(commonEntity, /entity is common across the observed AEGIX population/);

  const rare = commonalityWhy({ treatment: "MEANINGFUL", kind: "COUNTERPARTY" });
  assert.match(rare, /uncommon in the currently observed AEGIX population/);

  const fallback = commonalityWhy({ treatment: "STATIC", kind: "COUNTERPARTY" });
  assert.match(fallback, /static common-activity treatment applies/);
});

test("commonality copy: disclaimer language present for every empirical claim", () => {
  // The frequency label embeds the population scope ("AEGIX-analyzed
  // wallets") — the UI section additionally renders the full disclaimer.
  const freq = commonalityFrequencyLabel({ frequency: 0.004, populationSize: 240, treatment: "MEANINGFUL" });
  assert.match(freq, /AEGIX-analyzed/);
  assert.doesNotMatch(freq, /entire Solana network/); // full disclaimer lives in the section, not per note
});
