import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTemporalCorrelation, type TemporalActivity } from "./dimensions/temporal.js";

function at(iso: string, signature = `sig-${iso}`): TemporalActivity {
  return { timestamp: iso, signature };
}

// Helper: base timestamp T0, then txs at T0 + offsets.
function series(base: string, offsetsSeconds: number[]): TemporalActivity[] {
  const baseMs = new Date(base).getTime();
  return offsetsSeconds.map((o, i) => {
    const ts = new Date(baseMs + o * 1000).toISOString();
    return at(ts, `sig-${i}-${o}`);
  });
}

const T0 = "2026-02-01T12:00:00Z";

test("TEMPORAL: repeated 45s window activity → moderate strength", () => {
  // A and B both active within ~45s, repeated 5 times across days.
  const a = series(T0, [0, 86400, 172800, 259200, 345600]);
  const b = series(T0, [45, 86445, 172845, 259245, 345645]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000 });
  assert.ok(r !== null, "temporal family present");
  assert.ok(r.strength >= 0.4, `strength ${r.strength}`);
  assert.ok(r.evidence.some((e) => e.key === "observed_matches"), "matched windows exposed");
});

test("TEMPORAL: single coincidence is weak/null", () => {
  const a = series(T0, [0]);
  const b = series(T0, [45]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000 });
  // Below minimum repetition → no family at all.
  assert.equal(r, null);
});

test("TEMPORAL: high-volume unrelated wallets do not correlate (base rate)", () => {
  // 200 random-ish txs each over 7 days — expected collisions are high.
  const offsetsA = Array.from({ length: 200 }, (_, i) => i * 3000 + (i % 7) * 86400);
  const offsetsB = Array.from({ length: 200 }, (_, i) => i * 3000 + 1500 + ((i + 3) % 7) * 86400);
  const a = series(T0, offsetsA);
  const b = series(T0, offsetsB);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 7 * 86400 });
  // Either no family or weak — never high.
  if (r) {
    assert.ok(r.strength < 0.5, `strength ${r.strength}`);
  }
});

test("TEMPORAL: same active hours only is weak", () => {
  // Both active only at 12:00 UTC but on different days, never close in time.
  const a = series(T0, [0, 86400, 172800]);
  const b = series("2026-02-01T12:30:00Z", [0, 86400, 172800]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000 });
  if (r) {
    assert.ok(r.strength < 0.4, `strength ${r.strength}`);
    assert.ok(r.limitations.some((l) => l.includes("base rate")), "limitation about base rate");
  }
});

test("TEMPORAL: directional sequence A→B repeated", () => {
  const a = series(T0, [0, 86400, 172800, 259200]);
  const b = series(T0, [60, 86460, 172860, 259260]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000 });
  assert.ok(r !== null);
  assert.ok(r.evidence.some((e) => e.key === "directional_sequence"), "directional sequence evidence");
});

test("TEMPORAL: low sample caps confidence", () => {
  const a = series(T0, [0, 86400]);
  const b = series(T0, [45, 86445]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000 });
  if (r) {
    assert.ok(r.confidence <= 0.6, `confidence ${r.confidence}`);
  }
});

test("TEMPORAL: low data quality caps confidence", () => {
  const a = series(T0, [0, 86400, 172800, 259200, 345600]);
  const b = series(T0, [45, 86445, 172845, 259245, 345645]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000, dataQualityA: 0.2, dataQualityB: 0.3 });
  assert.ok(r !== null);
  assert.ok(r.confidence <= 0.6, `confidence ${r.confidence}`);
});

test("TEMPORAL: safe language — never timezone/country/location", () => {
  const a = series(T0, [0, 86400, 172800, 259200, 345600]);
  const b = series(T0, [45, 86445, 172845, 259245, 345645]);
  const r = evaluateTemporalCorrelation({ walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000 });
  assert.ok(r !== null);
  const text = JSON.stringify(r).toLowerCase();
  assert.ok(!text.includes("timezone"));
  assert.ok(!text.includes("country"));
  assert.ok(!text.includes("location"));
});

test("TEMPORAL: a transaction never matches itself across the two wallets", () => {
  // A direct A→B transfer is ONE transaction that appears in both wallets'
  // activity with the same signature and the same block time. Pairing it with
  // itself produced a guaranteed Δ0s "match", which drove TEMPORAL_CORRELATION
  // to its maximum strength on evidence the FUNDING and TRANSFER families had
  // already counted.
  const shared = ["tx1", "tx2", "tx3", "tx4"].map((signature, i) => ({
    timestamp: new Date(new Date(T0).getTime() + i * 86400 * 1000).toISOString(),
    signature
  }));
  const r = evaluateTemporalCorrelation({
    walletA: "A",
    walletB: "B",
    activityA: shared,
    activityB: shared,
    observationPeriodSeconds: 400000
  });
  assert.equal(r, null, "identical transactions are not independent timing evidence");
});

test("TEMPORAL: excluded signatures are dropped before analysis", () => {
  const a = series(T0, [0, 86400, 172800, 259200, 345600]);
  const b = series(T0, [45, 86445, 172845, 259245, 345645]);
  const withEvidence = evaluateTemporalCorrelation({
    walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000
  });
  assert.ok(withEvidence !== null, "baseline temporal family present");

  const excludedA = new Set(a.map((x) => x.signature!));
  const excluded = evaluateTemporalCorrelation({
    walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000,
    excludedSignaturesA: excludedA
  });
  assert.equal(excluded, null, "excluding all of A's activity leaves nothing to correlate");
});

test("TEMPORAL: partial exclusion is disclosed as a limitation", () => {
  const a = series(T0, [0, 86400, 172800, 259200, 345600, 432000]);
  const b = series(T0, [45, 86445, 172845, 259245, 345645, 432045]);
  const r = evaluateTemporalCorrelation({
    walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 500000,
    excludedSignaturesA: new Set([a[0]!.signature!])
  });
  assert.ok(r !== null);
  assert.ok(
    r.limitations.some((l) => l.includes("excluded from timing analysis")),
    `exclusion must be disclosed: ${r.limitations.join(" | ")}`
  );
});

test("TEMPORAL: unrelated wallets acting in the same window still correlate", () => {
  // The self-match guard must not suppress genuine coincident activity — only
  // pairs that are literally the same transaction.
  const a = series(T0, [0, 86400, 172800, 259200, 345600]);
  const b = series(T0, [45, 86445, 172845, 259245, 345645]);
  const r = evaluateTemporalCorrelation({
    walletA: "A", walletB: "B", activityA: a, activityB: b, observationPeriodSeconds: 400000
  });
  assert.ok(r !== null, "distinct transactions in a tight window remain evidence");
  assert.ok(r.strength >= 0.4, `strength ${r.strength}`);
});
