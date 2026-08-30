import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntelligenceSignal } from "@aegix/types";
import { explainPath, explainSignal } from "./index.js";

function signal(type: string, evidence: IntelligenceSignal["evidence"], summary = ""): IntelligenceSignal {
  return {
    type,
    category: "FUNDING",
    severity: 60,
    confidence: 0.91,
    title: type,
    summary,
    evidence,
    engineVersion: "test"
  };
}

test("explains repeated funding with evidence", () => {
  const text = explainSignal(
    signal("REPEATED_FUNDING", [
      { key: "counterparty", value: "WalletB", label: "Counterparty" },
      { key: "count", value: 14, label: "Count" },
      { key: "period_days", value: 43, label: "Period days" }
    ])
  );
  assert.match(text, /14 times/);
  assert.match(text, /43 days/);
  assert.match(text, /may increase wallet linkability/);
});

test("explanation never claims identity", () => {
  const text = explainSignal(
    signal("POTENTIAL_CLUSTER_LINK", [
      { key: "counterparty", value: "X", label: "Counterparty" },
      { key: "share_count", value: 3, label: "Share count" }
    ])
  );
  assert.doesNotMatch(text, /same person|definitely|confirmed identity/i);
  assert.match(text, /do not prove common ownership/);
});

test("explains attack paths neutrally", () => {
  const text = explainPath({
    nodes: [
      { type: "WALLET", label: "Target" },
      { type: "WALLET", label: "Funder" },
      { type: "ENTITY", label: "Exchange" }
    ],
    pathScore: 0.5,
    confidenceScore: 0.7
  });
  assert.match(text, /potential linkability/);
  assert.doesNotMatch(text, /belong to the same person/i);
});
