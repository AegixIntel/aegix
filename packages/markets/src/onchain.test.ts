import assert from "node:assert/strict";
import { test } from "node:test";
import { marketTemporalContext } from "./onchain.js";
import { assessFreshness } from "./normalize.js";
import type { MarketSnapshot } from "./types.js";
test("temporal context only matches existing timestamped evidence within a bounded window", () => {
  const snapshot: MarketSnapshot = { quote: { asset: "SOL", priceUsd: 1, provider: "fixture", volume24hUsd: null, marketCapUsd: null, percentChange24h: null, freshness: assessFreshness(null) },
    history: [{ timestamp: "2026-09-12T10:00:00Z", priceUsd: 1, volumeUsd: null }], signals: [], quality: { grade: "LOW", issues: [], historyPoints: 1 }, engineVersion: "fixture", providerStatus: "OK", limitations: [] };
  const matches = marketTemporalContext(snapshot, [{ evidenceId: "sig:FUNDING", timestamp: "2026-09-12T10:02:00Z" }, { evidenceId: "ind:OTHER", timestamp: "2026-09-10T10:00:00Z" }, { evidenceId: "system:ignore", timestamp: "2026-09-12T10:00:00Z" }]);
  assert.equal(matches.length, 1); assert.equal(matches[0]!.offsetSeconds, -120);
  assert.deepEqual(matches[0]!.evidenceRefs, ["sig:FUNDING", "cov:market:SOL:history"]);
  assert.ok(matches[0]!.note.includes("does not establish causation"));
});
