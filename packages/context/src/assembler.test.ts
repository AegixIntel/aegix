import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntelligenceSignal, SignalCategory } from "@aegix/types";
import { MIN_TRANSACTIONS_FOR_CONTEXT, buildWalletContext, type WalletContextInput } from "./assembler.js";
import { containsUnsafeClaim } from "./rules.js";
import { CONTEXT_ENGINE_VERSION } from "./types.js";

const WALLET = "So11111111111111111111111111111111111111112";

function signal(over: Partial<IntelligenceSignal> & { type: string; category: SignalCategory }): IntelligenceSignal {
  return {
    severity: 50,
    confidence: 0.7,
    title: over.type,
    summary: `AEGIX observed ${over.type} within the analysed history.`,
    evidence: [{ key: "count", value: 3, label: "Occurrences" }],
    engineVersion: "funding-v1.0.0",
    ...over
  };
}

function input(over: Partial<WalletContextInput> = {}): WalletContextInput {
  return {
    walletAddress: WALLET,
    analysisId: "analysis-1",
    pipelineVersion: "aegix-pipeline-v1.1.0",
    scoringVersion: "score-v1.1.0",
    signals: [],
    dimensions: [{ key: "fundingExposure", label: "Funding Exposure", score: 40 }],
    coverage: {
      transactionsParsed: 30,
      historyStart: "2026-08-01T00:00:00.000Z",
      historyEnd: "2026-09-01T00:00:00.000Z",
      dataQualityScore: 80,
      grade: "HIGH"
    },
    ...over
  };
}

test("indicator carries its source engine, engine version and evidence", () => {
  const profile = buildWalletContext(
    input({ signals: [signal({ type: "REPEATED_FUNDING", category: "FUNDING", engineVersion: "funding-v1.2.0" })] })
  );

  assert.equal(profile.indicators.length, 1);
  const indicator = profile.indicators[0]!;
  assert.equal(indicator.id, "ind:REPEATED_FUNDING");
  assert.deepEqual(indicator.evidenceRefs, ["sig:REPEATED_FUNDING"]);
  assert.equal(indicator.sourceEngine, "funding");
  assert.equal(indicator.engineVersion, "funding-v1.2.0");
  assert.deepEqual(indicator.evidence, [{ key: "count", value: 3, label: "Occurrences" }]);
  assert.equal(indicator.confidence, 0.7);
  assert.equal(profile.engineVersions.context, CONTEXT_ENGINE_VERSION);
});

test("duplicate signal types yield one stable indicator regardless of row order", () => {
  const signals = [signal({ type: "REPEATED_FUNDING", category: "FUNDING", severity: 20 }),
    signal({ type: "REPEATED_FUNDING", category: "FUNDING", severity: 60 })];
  const forward = buildWalletContext(input({ signals }));
  const reverse = buildWalletContext(input({ signals: [...signals].reverse() }));
  assert.deepEqual(forward, reverse);
  assert.equal(forward.indicators.length, 1);
  assert.equal(forward.indicators[0]!.severity, 60);
});

test("rule 1: absence signals never become indicators", () => {
  const profile = buildWalletContext(
    input({
      signals: [
        signal({ type: "NO_INCOMING_FUNDING", category: "FUNDING" }),
        signal({ type: "NO_COUNTERPARTIES", category: "COUNTERPARTY" })
      ]
    })
  );

  assert.equal(profile.indicators.length, 0);
  assert.deepEqual(
    profile.suppressed.map((s) => [s.signalType, s.reason]),
    [
      ["NO_COUNTERPARTIES", "ABSENCE_NOT_EVIDENCE"],
      ["NO_INCOMING_FUNDING", "ABSENCE_NOT_EVIDENCE"]
    ]
  );
});

test("rule 1: absence is never rendered as safety", () => {
  const profile = buildWalletContext(
    input({ signals: [signal({ type: "NO_COUNTERPARTIES", category: "COUNTERPARTY" })] })
  );

  const text = JSON.stringify(profile).toLowerCase();
  for (const claim of ["clean", "no risk", "safe wallet", "low risk"]) {
    assert.ok(!text.includes(claim), `profile must not contain "${claim}"`);
  }
});

test("rule 2: the aggregate is not listed beside the evidence it consumed", () => {
  const profile = buildWalletContext(
    input({
      signals: [
        signal({ type: "REPEATED_FUNDING", category: "FUNDING", severity: 60 }),
        signal({ type: "KNOWN_ENTITY_INTERACTION", category: "ENTITY", severity: 55 }),
        signal({
          type: "CONVERGING_LINKABILITY_EVIDENCE",
          category: "IDENTITY_LINKABILITY",
          severity: 72,
          confidence: 0.8,
          engineVersion: "linkability-v1.0.0"
        })
      ]
    })
  );

  assert.deepEqual(profile.indicators.map((i) => i.signalType), ["REPEATED_FUNDING", "KNOWN_ENTITY_INTERACTION"]);
  assert.ok(!profile.indicators.some((i) => i.category === "IDENTITY_LINKABILITY"));
  assert.equal(profile.linkability.converged, true);
  assert.equal(profile.linkability.severity, 72);
  assert.deepEqual(profile.linkability.contributingCategories, ["ENTITY", "FUNDING"]);
  assert.deepEqual(
    profile.suppressed.filter((s) => s.reason === "AGGREGATE_OF_LISTED_EVIDENCE").map((s) => s.signalType),
    ["CONVERGING_LINKABILITY_EVIDENCE"]
  );
});

test("rule 2: with no aggregate, linkability reports no convergence rather than nothing", () => {
  const profile = buildWalletContext(
    input({ signals: [signal({ type: "REPEATED_FUNDING", category: "FUNDING" })] })
  );

  assert.equal(profile.linkability.converged, false);
  assert.equal(profile.linkability.severity, null);
  assert.deepEqual(profile.linkability.contributingCategories, []);
});

test("rule 3: sparse wallets withhold statistical categories but keep observed events", () => {
  const profile = buildWalletContext(
    input({
      coverage: {
        transactionsParsed: MIN_TRANSACTIONS_FOR_CONTEXT - 1,
        historyStart: null,
        historyEnd: null,
        dataQualityScore: 20,
        grade: "LOW"
      },
      signals: [
        signal({ type: "ODD_HOUR_CONCENTRATION", category: "TRANSACTION_PATTERN" }),
        signal({ type: "NARROW_ACTIVITY_WINDOW", category: "BEHAVIORAL" }),
        signal({ type: "KNOWN_ENTITY_INTERACTION", category: "ENTITY" })
      ]
    })
  );

  assert.equal(profile.sufficiency, "INSUFFICIENT_ACTIVITY");
  assert.deepEqual(profile.indicators.map((i) => i.signalType), ["KNOWN_ENTITY_INTERACTION"]);
  assert.deepEqual(
    profile.suppressed.filter((s) => s.reason === "INSUFFICIENT_ACTIVITY").map((s) => s.signalType),
    ["NARROW_ACTIVITY_WINDOW", "ODD_HOUR_CONCENTRATION"]
  );
});

test("rule 3: at the threshold the statistical categories are reported", () => {
  const profile = buildWalletContext(
    input({
      coverage: {
        transactionsParsed: MIN_TRANSACTIONS_FOR_CONTEXT,
        historyStart: null,
        historyEnd: null,
        dataQualityScore: 50,
        grade: "MEDIUM"
      },
      signals: [signal({ type: "ODD_HOUR_CONCENTRATION", category: "TRANSACTION_PATTERN" })]
    })
  );

  assert.equal(profile.sufficiency, "SUFFICIENT");
  assert.deepEqual(profile.indicators.map((i) => i.signalType), ["ODD_HOUR_CONCENTRATION"]);
});

test("no curated risk dataset is reported as unchecked, never as clean", () => {
  const profile = buildWalletContext(input());

  assert.equal(profile.knownRisk.dataset, "NOT_AVAILABLE");
  assert.equal(profile.knownRisk.match, "NOT_CHECKED");
  assert.ok(profile.limitations.includes(profile.knownRisk.note));
});

test("an unsupported claim in a summary is replaced, not passed through", () => {
  const profile = buildWalletContext(
    input({
      signals: [
        signal({
          type: "REPEATED_FUNDING",
          category: "FUNDING",
          summary: "This wallet belongs to the same owner as the funder."
        })
      ]
    })
  );

  const indicator = profile.indicators[0]!;
  assert.ok(!containsUnsafeClaim(indicator.description));
  assert.ok(indicator.description.includes("REPEATED_FUNDING"));
  assert.ok(indicator.description.includes("funding"));
});

test("every rendered string stays within the safe-language policy", () => {
  const profile = buildWalletContext(
    input({
      signals: [
        signal({ type: "REPEATED_FUNDING", category: "FUNDING" }),
        signal({
          type: "CONVERGING_LINKABILITY_EVIDENCE",
          category: "IDENTITY_LINKABILITY",
          engineVersion: "linkability-v1.0.0"
        }),
        signal({ type: "NO_COUNTERPARTIES", category: "COUNTERPARTY" })
      ]
    })
  );

  const strings = [
    ...profile.indicators.flatMap((i) => [i.title, i.description]),
    profile.linkability.note,
    profile.knownRisk.note,
    ...profile.limitations
  ];
  for (const text of strings) {
    assert.ok(!containsUnsafeClaim(text), `unsafe claim in: ${text}`);
  }
});

test("indicator ordering is deterministic across input order", () => {
  const signals = [
    signal({ type: "A_LOW", category: "FUNDING", severity: 10 }),
    signal({ type: "B_HIGH", category: "ENTITY", severity: 90 }),
    signal({ type: "C_MID", category: "COUNTERPARTY", severity: 50, confidence: 0.9 }),
    signal({ type: "D_MID", category: "CLUSTER", severity: 50, confidence: 0.5 })
  ];
  const forward = buildWalletContext(input({ signals })).indicators.map((i) => i.signalType);
  const reverse = buildWalletContext(input({ signals: [...signals].reverse() })).indicators.map((i) => i.signalType);

  assert.deepEqual(forward, ["B_HIGH", "C_MID", "D_MID", "A_LOW"]);
  assert.deepEqual(forward, reverse);
});

test("history limitation names the analysed window rather than the wallet lifetime", () => {
  const profile = buildWalletContext(input());
  const history = profile.limitations.find((l) => l.includes("analysed history"));

  assert.ok(history, "expected a bounded-history limitation");
  assert.ok(history.includes("2026-08-01T00:00:00.000Z"));
  assert.ok(history.includes("lifetime"));
});
