import assert from "node:assert/strict";
import { test } from "node:test";
import { isFreshHeartbeat, WORKER_HEARTBEAT_MAX_AGE_MS } from "./health.js";

test("worker heartbeat freshness is fail-closed", () => {
  const now = 1_800_000_000_000;
  assert.equal(isFreshHeartbeat(String(now - 1_000), now), true);
  assert.equal(isFreshHeartbeat(String(now - WORKER_HEARTBEAT_MAX_AGE_MS - 1), now), false);
  assert.equal(isFreshHeartbeat(String(now + 1), now), false);
  assert.equal(isFreshHeartbeat("not-a-number", now), false);
  assert.equal(isFreshHeartbeat(null, now), false);
});
