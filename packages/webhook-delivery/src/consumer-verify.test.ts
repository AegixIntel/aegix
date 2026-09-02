/**
 * D6-I4 consumer verification helper tests. Every test exercises the exact
 * signing scheme the delivery side uses (HMAC-SHA256 over
 * `timestamp + "." + rawBody`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWebhookRequest, CONSUMER_WEBHOOK_HEADERS } from "./consumer-verify.js";
import { signWebhookPayload } from "./webhook-crypto.js";

const SECRET = "whsec_test_secret";
const NOW = 1_720_000_000;

function sign(rawBody: string, at = NOW): { signature: string; timestamp: string } {
  return { signature: signWebhookPayload(SECRET, String(at), rawBody), timestamp: String(at) };
}

test("headers: consumer header names match the delivery side", () => {
  assert.equal(CONSUMER_WEBHOOK_HEADERS.signature, "aegix-signature");
  assert.equal(CONSUMER_WEBHOOK_HEADERS.timestamp, "aegix-timestamp");
  assert.equal(CONSUMER_WEBHOOK_HEADERS.id, "aegix-webhook-id");
  assert.equal(CONSUMER_WEBHOOK_HEADERS.eventId, "aegix-event-id");
});

test("valid signature + fresh timestamp verifies", () => {
  const body = JSON.stringify({ id: "evt_1", type: "monitor.threat.created", data: {} });
  const { signature, timestamp } = sign(body);
  const r = verifyWebhookRequest({ rawBody: body, signature, timestamp, secret: SECRET, nowSeconds: NOW });
  assert.deepEqual(r, { valid: true });
});

test("modified body fails (raw bytes matter)", () => {
  const body = JSON.stringify({ id: "evt_1", type: "monitor.threat.created", data: {} });
  const { signature, timestamp } = sign(body);
  const tampered = body.replace("evt_1", "evt_2");
  const r = verifyWebhookRequest({ rawBody: tampered, signature, timestamp, secret: SECRET, nowSeconds: NOW });
  assert.equal(r.valid, false);
  assert.equal((r as { reason: string }).reason, "SIGNATURE_MISMATCH");
});

test("JSON re-serialization differences invalidate the signature", () => {
  // parse → stringify of the SAME object usually reproduces identical bytes
  // when key order is preserved, but NOT always (number formats, unicode
  // escapes, whitespace). The protocol signs the EXACT raw bytes, so a
  // consumer that re-serializes with ANY difference must fail. Fixture with
  // real raw-whitespace differences:
  const raw = `{ "a": 1, "list": [1, 2] }`; // spaces
  const { signature, timestamp } = sign(raw);
  const reserialized = JSON.stringify(JSON.parse(raw)); // compact
  assert.notEqual(reserialized, raw, "fixture must differ after re-serialization");
  const r = verifyWebhookRequest({ rawBody: reserialized, signature, timestamp, secret: SECRET, nowSeconds: NOW });
  assert.equal(r.valid, false);
});

test("unicode + empty bodies are signed byte-exact", () => {
  const unicode = JSON.stringify({ note: "héllo — vérification ✓" });
  const { signature, timestamp } = sign(unicode);
  assert.equal(verifyWebhookRequest({ rawBody: unicode, signature, timestamp, secret: SECRET, nowSeconds: NOW }).valid, true);
  // A different-but-similar unicode normalization fails.
  const composed = unicode.normalize("NFC");
  assert.equal(verifyWebhookRequest({ rawBody: composed, signature, timestamp, secret: SECRET, nowSeconds: NOW }).valid, unicode === composed);

  const empty = "";
  const e = sign(empty);
  assert.equal(verifyWebhookRequest({ rawBody: empty, signature: e.signature, timestamp: e.timestamp, secret: SECRET, nowSeconds: NOW }).valid, true);
});

test("wrong secret fails", () => {
  const body = "{}";
  const { signature, timestamp } = sign(body);
  const r = verifyWebhookRequest({ rawBody: body, signature, timestamp, secret: "wrong_secret", nowSeconds: NOW });
  assert.equal(r.valid, false);
  assert.equal((r as { reason: string }).reason, "SIGNATURE_MISMATCH");
});

test("modified timestamp fails", () => {
  const body = "{}";
  const { signature } = sign(body, NOW);
  const r = verifyWebhookRequest({ rawBody: body, signature, timestamp: String(NOW + 1), secret: SECRET, nowSeconds: NOW });
  assert.equal(r.valid, false);
});

test("expired timestamp (too old) fails", () => {
  const body = "{}";
  const { signature, timestamp } = sign(body, NOW - 1000);
  const r = verifyWebhookRequest({ rawBody: body, signature, timestamp, secret: SECRET, toleranceSeconds: 300, nowSeconds: NOW });
  assert.equal(r.valid, false);
  assert.equal((r as { reason: string }).reason, "TOO_OLD");
});

test("future timestamp (too far ahead) fails", () => {
  const body = "{}";
  const { signature, timestamp } = sign(body, NOW + 1000);
  const r = verifyWebhookRequest({ rawBody: body, signature, timestamp, secret: SECRET, toleranceSeconds: 300, nowSeconds: NOW });
  assert.equal(r.valid, false);
  assert.equal((r as { reason: string }).reason, "TOO_FAR_IN_FUTURE");
});

test("within tolerance verifies even when slightly skewed", () => {
  const body = "{}";
  const { signature, timestamp } = sign(body, NOW - 120);
  assert.equal(verifyWebhookRequest({ rawBody: body, signature, timestamp, secret: SECRET, toleranceSeconds: 300, nowSeconds: NOW }).valid, true);
});

test("malformed inputs are rejected with explicit reasons", () => {
  const body = "{}";
  assert.equal((verifyWebhookRequest({ rawBody: body, signature: null, timestamp: String(NOW), secret: SECRET, nowSeconds: NOW }) as { reason: string }).reason, "MISSING_SIGNATURE");
  assert.equal((verifyWebhookRequest({ rawBody: body, signature: "ab", timestamp: null, secret: SECRET, nowSeconds: NOW }) as { reason: string }).reason, "MISSING_TIMESTAMP");
  assert.equal((verifyWebhookRequest({ rawBody: body, signature: "ab", timestamp: "not-a-number", secret: SECRET, nowSeconds: NOW }) as { reason: string }).reason, "MALFORMED_TIMESTAMP");
  assert.equal((verifyWebhookRequest({ rawBody: body, signature: "zz-not-hex", timestamp: String(NOW), secret: SECRET, nowSeconds: NOW }) as { reason: string }).reason, "MALFORMED_SIGNATURE");
  // Replay protection: signature valid but timestamp already used beyond tolerance.
  const { signature, timestamp } = sign(body, NOW);
  const replay = verifyWebhookRequest({ rawBody: body, signature, timestamp, secret: SECRET, toleranceSeconds: 0, nowSeconds: NOW + 1 });
  assert.equal(replay.valid, false);
});
