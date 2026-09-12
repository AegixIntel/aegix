import assert from "node:assert/strict";
import { test } from "node:test";
import { assessFreshness, assessQuality, normalizeHistory } from "./normalize.js";
const now = new Date("2026-09-12T10:00:00Z");
test("freshness uses provider time and rejects missing, invalid and future timestamps", () => {
  assert.equal(assessFreshness("2026-09-12T09:59:00Z", now).status, "FRESH");
  assert.equal(assessFreshness("2026-09-12T09:45:00Z", now).status, "STALE");
  for (const timestamp of [null, "garbage", "2026-09-12T08:00:00Z", "2026-09-13T00:00:00Z"]) assert.equal(assessFreshness(timestamp, now).status, "UNAVAILABLE");
});
test("history is finite, chronological, deduplicated and does not invent absent volume", () => {
  const points = [{ timestamp: "2026-09-12T09:00:00Z", priceUsd: 2, volumeUsd: -1 },
    { timestamp: "bad", priceUsd: 2, volumeUsd: 5 },
    { timestamp: "2026-09-12T08:00:00Z", priceUsd: 1, volumeUsd: null },
    { timestamp: "2026-09-12T08:00:00Z", priceUsd: 1, volumeUsd: null },
    { timestamp: "2026-09-12T07:00:00Z", priceUsd: Infinity, volumeUsd: 1 }];
  const result = normalizeHistory(points);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.priceUsd, 1);
  assert.equal(result[1]!.volumeUsd, null);
  assert.deepEqual(result, normalizeHistory([...points].reverse()));
});
test("insufficient history and unavailable volume downgrade quality explicitly", () => {
  const quality = assessQuality({ freshness: assessFreshness(null, now), history: [], volume24hUsd: null, expectedPoints: 24 });
  assert.equal(quality.grade, "LOW"); assert.equal(quality.issues.length, 3);
});
