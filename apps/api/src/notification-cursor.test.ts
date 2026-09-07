import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeNotificationCursor, encodeNotificationCursor } from "./notification-cursor.js";

test("notification cursor round-trips timestamp and id", () => {
  const value = { createdAt: "2026-09-06T12:34:56.000Z", id: "42" };
  assert.deepEqual(decodeNotificationCursor(encodeNotificationCursor(value)), value);
});

test("notification cursor rejects malformed and incomplete values", () => {
  for (const value of ["", "%%%", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ createdAt: "bad", id: "1" })).toString("base64url")]) {
    assert.throws(() => decodeNotificationCursor(value), /Invalid notification cursor/);
  }
});
