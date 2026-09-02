import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import {
  buildAuthMessage,
  hashNonce,
  canonicalIso,
  hashToken,
  WALLET_AUTH_MESSAGE_VERSION
} from "./wallet-auth.js";

// Deterministic keypair used across tests (public key = the "wallet").
const privateKey = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(privateKey);
const WALLET = base58.encode(publicKey);

function messageInput(overrides: Record<string, string> = {}) {
  return {
    domain: "http://localhost:3000",
    wallet: WALLET,
    uri: "http://localhost:3000",
    nonce: "abc123nonce",
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-02T00:05:00.000Z",
    statement: "Sign in to AEGIX. This message does not create a blockchain transaction and does not cost SOL.",
    version: WALLET_AUTH_MESSAGE_VERSION,
    ...overrides
  };
}

test("buildAuthMessage: deterministic, human-readable, contains version", () => {
  const a = buildAuthMessage(messageInput());
  const b = buildAuthMessage(messageInput());
  assert.equal(a, b);
  assert.ok(a.includes("AEGIX authentication"));
  assert.ok(a.includes(WALLET));
  assert.ok(a.includes("Nonce: abc123nonce"));
  assert.ok(a.includes(`Version: ${WALLET_AUTH_MESSAGE_VERSION}`));
});

test("signature over the exact message verifies; modified bytes fail", () => {
  const message = buildAuthMessage(messageInput());
  const sig = ed25519.sign(new TextEncoder().encode(message), privateKey);
  assert.equal(ed25519.verify(sig, new TextEncoder().encode(message), publicKey), true);

  // A single modified byte in the message must fail verification.
  const tampered = message.replace("Nonce: abc123nonce", "Nonce: abc123noncd");
  assert.equal(ed25519.verify(sig, new TextEncoder().encode(tampered), publicKey), false);

  // Signature over a different wallet must fail.
  const otherKey = ed25519.getPublicKey(new Uint8Array(32).fill(9));
  assert.equal(ed25519.verify(sig, new TextEncoder().encode(message), otherKey), false);
});

test("hashNonce: sha256 hex, deterministic, not reversible", () => {
  const h = hashNonce("abc123nonce");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashNonce("abc123nonce"));
  assert.notEqual(h, hashNonce("abc123noncd"));
});

test("canonicalIso: normalizes timestamps to millisecond ISO", () => {
  assert.equal(canonicalIso("2026-09-02T00:00:00.000Z"), "2026-09-02T00:00:00.000Z");
  assert.equal(canonicalIso("2026-09-02T00:00:00.123Z"), "2026-09-02T00:00:00.123Z");
  // Non-ISO input is returned unchanged (defensive).
  assert.equal(canonicalIso("not-a-date"), "not-a-date");
});

test("hashToken: sha256 hex", () => {
  const t = "some-session-token";
  assert.equal(hashToken(t), hashToken(t));
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(t), hashToken(t + "x"));
});
