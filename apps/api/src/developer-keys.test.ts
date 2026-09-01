import assert from "node:assert/strict";
import { test } from "node:test";
import { API_KEY_PREFIX_LENGTH } from "@aegix/database";
import { generateApiKey, hashApiKey, verifyApiKey } from "./developer-keys.js";

// ---- D6-C: key material ----

test("developer key: format is aegix_live_<base58 random> with sufficient entropy", () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.ok(a.key.startsWith("aegix_live_"), "prefix");
  assert.ok(a.key.length > 30 && a.key.length < 60, `length ${a.key.length}`);
  // 128-bit random portion: two generations never collide in practice.
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.keyPrefix, b.keyPrefix);
  assert.match(a.key.slice("aegix_live_".length), /^[1-9A-HJ-NP-Za-km-z]+$/);
  // Key prefix is API_KEY_PREFIX_LENGTH chars (static prefix + random chars).
  assert.equal(a.keyPrefix, a.key.slice(0, API_KEY_PREFIX_LENGTH));
  assert.equal(a.keyPrefix.length, API_KEY_PREFIX_LENGTH);
});

test("developer key: hash is sha256 hex, deterministic, one-way", () => {
  const { key, keyHash } = generateApiKey();
  assert.equal(keyHash.length, 64);
  assert.equal(hashApiKey(key), keyHash);
  assert.notEqual(keyHash, key);
});

test("developer key: constant-time verify accepts only the exact key", () => {
  const { key, keyHash } = generateApiKey();
  assert.equal(verifyApiKey(key, keyHash), true);
  assert.equal(verifyApiKey(`${key}x`, keyHash), false);
  assert.equal(verifyApiKey(key.slice(0, -1), keyHash), false);
  assert.equal(verifyApiKey("aegix_live_" + "1".repeat(30), keyHash), false);
  // Malformed stored hash: length mismatch must not throw.
  assert.equal(verifyApiKey(key, "deadbeef"), false);
});

test("developer key: rotation generates a fresh key", () => {
  const old = generateApiKey();
  const rotated = generateApiKey();
  assert.notEqual(rotated.key, old.key);
  assert.notEqual(rotated.keyHash, old.keyHash);
});
