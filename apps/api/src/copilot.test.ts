import assert from "node:assert/strict";
import { test } from "node:test";
import { COPILOT_SYSTEM_PROMPT, buildBoundedContext, enforceGrounding } from "@aegix/ai";
import type { DiscoveryRow } from "@aegix/database";
import { buildSignalFeed, type CrossMarketView, type NarrativeRadarEntry } from "@aegix/sources";
import { recordToEvidence, type CopilotRecord } from "./copilot.js";
import { resolveSubject } from "./market-intelligence.js";

const AT = "2026-10-06T18:00:00.000Z";
const capture = (id: string, domain: "MARKET" | "NARRATIVE" | "SECTOR" | "ANOMALY", subject: string, type: string) => ({
  id, domain, subject, observedAt: AT, signals: [{ type, severity: 60, confidence: 1, title: `${subject} ${type}`, summary: `${subject} did ${type}.` }]
});
const feed = buildSignalFeed({ resolve: resolveSubject, captures: [
  capture("1", "MARKET", "SOL", "MOMENTUM"), capture("2", "NARRATIVE", "data-center", "NARRATIVE_ACCELERATION"),
  capture("3", "SECTOR", "XLU", "FUND_DAILY_MOVE"), capture("4", "ANOMALY", "market:BTC:price_usd", "SERIES_ANOMALY_UP")
] });
const radar: NarrativeRadarEntry[] = [
  { topic: "copper", label: "Copper", state: "ACCELERATING", recentMean: 12, baselineMean: 5, ratio: 2.4, recentHours: 6, baselineHours: 48, latestHour: AT, series: [] },
  { topic: "uranium", label: "Uranium", state: "INSUFFICIENT_DATA", recentMean: null, baselineMean: null, ratio: null, recentHours: 0, baselineHours: 0, latestHour: null, series: [] }
];
const crossMarket: CrossMarketView = {
  engineVersion: "cross-market-v1.0.0", asOf: AT,
  classes: [
    { marketClass: "CRYPTO", session: false, measured: 3, advancing: 3, median24hPercent: 4, median7dPercent: 9,
      members: [{ symbol: "SOL", label: "SOL", price: 200, priceAt: AT, return24hPercent: 4, return7dPercent: 9 }, { symbol: "ETH", label: "ETH", price: null, priceAt: null, return24hPercent: null, return7dPercent: null }] },
    { marketClass: "SECTOR_FUND", session: true, measured: 0, advancing: 0, median24hPercent: null, median7dPercent: null, members: [] }
  ],
  correlations: [{ a: "CRYPTO", b: "TOKENIZED_EQUITY", r: 0.41, pairedHours: 160 }, { a: "CRYPTO", b: "TOKENIZED_GOLD", r: null, pairedHours: 12 }],
  sectors: [], readings: [{ type: "BROAD_ADVANCE", title: "Most of what is priced around the clock is up on the day", summary: "9 of 10 are above it." }]
};
const discovery = { id: "33", series_a: "market:SOL:price_usd", series_b: "xstock:QQQx:price_usdc", lag_hours: 2, direction: "POSITIVE", engine_version: "discovery-v1.0.0",
  detected_at: AT, status: "CANDIDATE", card: { title: "SOL and QQQx", summary: "They moved together.", confidence: 0.97, qValue: 0.03, hypothesesTested: 195 } } as unknown as DiscoveryRow;
const record: CopilotRecord = { feed, radar, crossMarket, discoveries: [discovery], coverage: [{ domain: "MARKET", captures: 96, signalled: 4 }] };

test("every product's record becomes citable evidence with an ID the context accepts", () => {
  const items = recordToEvidence(record);
  const ids = items.map((item) => item.id);
  for (const id of [
    "sig:market:SOL:MOMENTUM", "sig:narrative:data-center:NARRATIVE_ACCELERATION", "sig:sector:XLU:FUND_DAILY_MOVE", "sig:anomaly:market-BTC-price_usd:SERIES_ANOMALY_UP",
    "ind:confluence:1", "sig:discovery:AEX-33", "ind:narrative:copper", "ind:cross:CRYPTO", "ind:cross:reading:1", "ind:cross:correlation:CRYPTO:TOKENIZED_EQUITY", "cov:record"
  ]) assert.ok(ids.includes(id), `${id} is offered`);
  assert.equal(new Set(ids).size, ids.length, "no two items share an ID");
  const context = buildBoundedContext(items, { maxItems: 40, maxChars: 12_000 });
  assert.deepEqual([...context.includedIds].sort(), [...ids].sort(), "none is refused for its ID");
});

test("what was not measured is not offered as evidence", () => {
  const ids = recordToEvidence(record).map((item) => item.id);
  assert.ok(!ids.includes("ind:narrative:uranium"), "a topic with too few hours on record");
  assert.ok(!ids.includes("ind:cross:SECTOR_FUND"), "a class with no measured member");
  assert.ok(!ids.includes("ind:cross:correlation:CRYPTO:TOKENIZED_GOLD"), "a correlation with too few shared hours");
  assert.ok(!recordToEvidence(record).find((item) => item.id === "ind:cross:CRYPTO")!.detail.includes("ETH"), "a member with no price");
});

test("products that are switched off are named as not read, and nothing is invented for them", () => {
  const items = recordToEvidence({ feed: null, radar: null, crossMarket: null, discoveries: null, coverage: [] });
  assert.deepEqual(items.map((item) => item.id), ["cov:record"]);
  assert.match(items[0]!.detail, /Discoveries not read \(switched off\)/);
  assert.match(items[0]!.detail, /absence of record, not absence of activity/);
});

test("an answer is held to the evidence offered, and the instructions forbid causes and advice", () => {
  const context = buildBoundedContext(recordToEvidence(record), { maxItems: 40, maxChars: 12_000 });
  const grounded = enforceGrounding({ summary: "x", limitations: [], findings: [
    { statement: "Copper coverage is accelerating.", evidenceIds: ["ind:narrative:copper"] },
    { statement: "Uranium coverage is accelerating.", evidenceIds: ["ind:narrative:uranium"] },
    { statement: "You should buy SOL.", evidenceIds: ["sig:market:SOL:MOMENTUM"] }
  ] }, context.includedIds);
  assert.deepEqual(grounded.answer.findings.map((f) => f.statement), ["Copper coverage is accelerating."]);
  assert.deepEqual([grounded.droppedFindings, grounded.droppedReferences], [2, 1]);
  assert.match(COPILOT_SYSTEM_PROMPT, /that is not a link between them/);
  assert.match(COPILOT_SYSTEM_PROMPT, /Never offer trading recommendations/);
});
