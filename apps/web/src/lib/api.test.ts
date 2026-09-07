import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { markNotificationRead } from "./api.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const status of [401, 404, 500]) {
  test(`markNotificationRead rejects HTTP ${status}`, async () => {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(() => markNotificationRead("42"), new RegExp(String(status)));
  });
}

test("markNotificationRead resolves only for an OK response", async () => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await markNotificationRead("42");
});
