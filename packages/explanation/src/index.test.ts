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

test("every signal type an engine can emit has an explicit explanation", () => {
  // Keep in sync with docs/signal-taxonomy.md. The default branch would
  // return title + summary, so this asserts the explicit branch was taken
  // by checking for wording the generic fallback cannot produce.
  const cases: Array<[string, IntelligenceSignal["evidence"], RegExp]> = [
    [
      "LARGE_TRANSFER_OUTLIER",
      [
        { key: "largest_transfer", value: 100, label: "Largest transfer" },
        { key: "median_transfer", value: 1, label: "Median transfer" },
        { key: "ratio", value: 100, label: "Largest ÷ median" },
        { key: "transfers_considered", value: 11, label: "Transfers considered" }
      ],
      /100× this wallet's own median/
    ],
    [
      "HIGH_FREQUENCY_ACTIVITY",
      [
        { key: "transactions_per_day", value: 40, label: "Transactions per day" },
        { key: "days_covered", value: 1, label: "Days covered" }
      ],
      /averages 40 transaction\(s\) per day/
    ],
    [
      "ODD_HOUR_CONCENTRATION",
      [
        { key: "odd_hour_share", value: 0.8, label: "Share in window" },
        { key: "baseline_share", value: 0.25, label: "Uniform baseline" }
      ],
      /80% of transactions .* against 25%/
    ],
    [
      "REPEATED_EXACT_AMOUNT",
      [
        { key: "occurrences", value: 5, label: "Occurrences" },
        { key: "repeated_share", value: 0.5, label: "Share of transfers" }
      ],
      /recurs 5 time\(s\), covering 50%/
    ],
    [
      "REGULAR_INTERVAL_ACTIVITY",
      [
        { key: "interval_regularity", value: 0.97, label: "Interval regularity" },
        { key: "median_interval_hours", value: 6, label: "Median gap (hours)" }
      ],
      /regularity 0\.97, median gap 6 hour/
    ],
    [
      "PUBLICLY_ATTRIBUTED_COUNTERPARTY",
      [
        { key: "entity", value: "Public Foundation", label: "Entity" },
        { key: "entity_type", value: "PUBLIC_ORGANIZATION", label: "Type" },
        { key: "label_status", value: "VERIFIED", label: "Label status" }
      ],
      /publicly labelled as Public Foundation/
    ],
    [
      "CUSTODIAL_DEPOSIT_ADDRESS_USE",
      [{ key: "entity", value: "Test Exchange", label: "Entity" }],
      /Test Exchange deposit address/
    ],
    [
      "CONVERGING_LINKABILITY_EVIDENCE",
      [
        { key: "converging_classes", value: 3, label: "Converging classes" },
        { key: "observed_classes", value: 2, label: "Observed classes" },
        { key: "class_list", value: "FUNDING, PUBLIC_ATTRIBUTION, BEHAVIORAL", label: "Classes" }
      ],
      /3 independent class\(es\).*2 of them from directly observed/
    ]
  ];

  for (const [type, evidence, expected] of cases) {
    const explanation = explainSignal(signal(type, evidence));
    assert.match(explanation, expected, `${type} must have an explicit explanation`);
  }
});

test("explanations of public attribution never claim ownership", () => {
  const attributed = explainSignal(
    signal("PUBLICLY_ATTRIBUTED_COUNTERPARTY", [
      { key: "entity", value: "Test Exchange", label: "Entity" },
      { key: "entity_type", value: "CENTRALIZED_EXCHANGE", label: "Type" },
      { key: "label_status", value: "VERIFIED", label: "Label status" }
    ])
  );
  const converging = explainSignal(
    signal("CONVERGING_LINKABILITY_EVIDENCE", [
      { key: "converging_classes", value: 2, label: "Converging classes" },
      { key: "observed_classes", value: 1, label: "Observed classes" },
      { key: "class_list", value: "FUNDING, BEHAVIORAL", label: "Classes" }
    ])
  );

  for (const text of [attributed, converging]) {
    assert.ok(!/\bowns\b|\bowner is\b|identified as|belongs to/i.test(text), `ownership claim in: ${text}`);
    assert.match(text, /does not establish who controls|nothing about who controls|not whose account/);
  }
});
