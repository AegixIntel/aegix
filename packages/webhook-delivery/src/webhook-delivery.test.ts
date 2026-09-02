import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebhookSecret, decryptWebhookSecret, signWebhookPayload, verifyWebhookSignature, WebhookSecretError, WEBHOOK_HEADERS } from "./webhook-crypto.js";
import { resolveWebhookDestination, isTransientStatus, isPermanentStatus, SsrfBlockedError, deliverWebhookOnce, type WebhookDeliveryContext } from "./index.js";

const TEST_CONFIG = {
  WEBHOOK_ENCRYPTION_KEY: "test-encryption-key-with-32-chars-minimum",
  WEBHOOK_ALLOWED_PORTS: "80,443",
  WEBHOOK_DEV_ALLOW_PRIVATE: false,
  WEBHOOK_TIMEOUT_MS: 2000,
  WEBHOOK_PAYLOAD_MAX_BYTES: 65536
} as unknown as Parameters<typeof createWebhookSecret>[0];

test("createWebhookSecret: encryption is reversible, secret is high-entropy", () => {
  const material = createWebhookSecret(TEST_CONFIG);
  assert.equal(material.secret.length, 43); // 32 bytes base64url
  assert.notEqual(material.secret, createWebhookSecret(TEST_CONFIG).secret);
  const decrypted = decryptWebhookSecret(TEST_CONFIG, material.encrypted, material.nonce);
  assert.equal(decrypted, material.secret);
  assert.equal(material.keyVersion, "v1");
});

test("decryptWebhookSecret: tampered ciphertext throws", () => {
  const material = createWebhookSecret(TEST_CONFIG);
  const tampered = material.encrypted.slice(0, -4) + "AAAA";
  assert.throws(() => decryptWebhookSecret(TEST_CONFIG, tampered, material.nonce));
});

test("decryptWebhookSecret: missing key throws", () => {
  assert.throws(() => createWebhookSecret({ ...TEST_CONFIG, WEBHOOK_ENCRYPTION_KEY: "" }), WebhookSecretError);
});

test("sign/verify: signature covers timestamp + body; tamper fails", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ id: "1", type: "monitor.threat.created" });
  const timestamp = "1720000000";
  const sig = signWebhookPayload(secret, timestamp, body);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, sig), true);
  assert.equal(verifyWebhookSignature(secret, timestamp, body + "x", sig), false);
  assert.equal(verifyWebhookSignature("wrong", timestamp, body, sig), false);
  assert.equal(verifyWebhookSignature(secret, "1720000001", body, sig), false);
  assert.ok(WEBHOOK_HEADERS.signature);
});

test("resolveWebhookDestination: rejects non-http(s) schemes", async () => {
  await assert.rejects(() => resolveWebhookDestination("ftp://example.com/hook", TEST_CONFIG), SsrfBlockedError);
});

test("resolveWebhookDestination: rejects private literal IPv4", async () => {
  await assert.rejects(() => resolveWebhookDestination("http://127.0.0.1/hook", TEST_CONFIG), SsrfBlockedError);
  await assert.rejects(() => resolveWebhookDestination("http://192.168.1.5/hook", TEST_CONFIG), SsrfBlockedError);
  await assert.rejects(() => resolveWebhookDestination("http://169.254.169.254/latest/meta-data", TEST_CONFIG), SsrfBlockedError);
});

test("resolveWebhookDestination: rejects private literal IPv6 (loopback/ULA)", async () => {
  await assert.rejects(() => resolveWebhookDestination("http://[::1]/hook", TEST_CONFIG), SsrfBlockedError);
  await assert.rejects(() => resolveWebhookDestination("http://[fd00::1]/hook", TEST_CONFIG), SsrfBlockedError);
});

test("resolveWebhookDestination: rejects disallowed ports", async () => {
  await assert.rejects(() => resolveWebhookDestination("https://example.com:8443/hook", TEST_CONFIG), SsrfBlockedError);
});

test("resolveWebhookDestination: allows public literal IPv4 on allowed port", async () => {
  const dest = await resolveWebhookDestination("http://8.8.8.8/hook", TEST_CONFIG);
  assert.equal(dest.ip, "8.8.8.8");
  assert.equal(dest.port, 80);
});

test("isTransientStatus / isPermanentStatus classification", () => {
  assert.equal(isTransientStatus(500), true);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(429), true);
  assert.equal(isTransientStatus(408), true);
  assert.equal(isTransientStatus(404), false);
  assert.equal(isTransientStatus(200), false);
  assert.equal(isPermanentStatus(404), true);
  assert.equal(isPermanentStatus(400), true);
  assert.equal(isPermanentStatus(429), false);
  assert.equal(isPermanentStatus(500), false);
});

test("deliverWebhookOnce: oversized payload throws", async () => {
  const material = createWebhookSecret(TEST_CONFIG);
  const webhook = {
    id: "1",
    url: "https://example.com/hook",
    secret_encrypted: material.encrypted,
    secret_nonce: material.nonce
  } as never;
  const ctx = {
    config: { ...TEST_CONFIG, WEBHOOK_PAYLOAD_MAX_BYTES: 10 },
    logger: { child: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
  } as unknown as WebhookDeliveryContext;
  await assert.rejects(
    () => deliverWebhookOnce(ctx, webhook, { id: "1", type: "t", createdAt: new Date().toISOString(), data: { big: "x".repeat(100) } }),
    /size limit/
  );
});
