/**
 * Production config validation tests (D6-J §60-§66): dangerous combinations
 * must fail fast at startup instead of silently degrading security.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./index.js";

function prodEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://prod:prod@db.internal:5432/aegix",
    REDIS_URL: "redis://redis.internal:6379",
    RPC_URL: "https://rpc.example.com",
    CORS_ORIGIN: "https://aegix.app",
    SUPABASE_URL: "https://supabase.example.com",
    SUPABASE_SERVICE_KEY: "service-key",
    AUTH_DOMAIN: "https://aegix.app",
    AUTH_APP_URI: "https://aegix.app",
    WEBHOOK_ENCRYPTION_KEY: "01234567890123456789012345678901",
    ...overrides
  };
}

test("production: valid minimal config loads", () => {
  const config = loadConfig(prodEnv());
  assert.equal(config.NODE_ENV, "production");
  assert.equal(config.EMAIL_ENABLED, false);
  assert.equal(config.ENABLE_EMAIL_NOTIFICATIONS, false);
});

test("production: public beta starts without SMTP configuration", () => {
  const config = loadConfig(prodEnv({
    EMAIL_ENABLED: "false",
    ENABLE_EMAIL_NOTIFICATIONS: "false",
    EMAIL_SMTP_HOST: "",
    EMAIL_SMTP_USER: "",
    EMAIL_SMTP_PASS: ""
  }));
  assert.equal(config.EMAIL_ENABLED, false);
  assert.equal(config.ENABLE_EMAIL_NOTIFICATIONS, false);
});

test("production: missing WEBHOOK_ENCRYPTION_KEY fails when webhooks enabled (D6-J §60)", () => {
  assert.throws(() => loadConfig(prodEnv({ ENABLE_WEBHOOK_DELIVERY: "true", WEBHOOK_ENCRYPTION_KEY: "" })), /WEBHOOK_ENCRYPTION_KEY/);
  // Explicitly disabling webhook delivery is a valid state.
  assert.doesNotThrow(() => loadConfig(prodEnv({ ENABLE_WEBHOOK_DELIVERY: "false" })));
});

test("production: email+smtp without host fails fast (D6-J §61)", () => {
  assert.throws(
    () => loadConfig(prodEnv({ EMAIL_ENABLED: "true", EMAIL_PROVIDER: "smtp", EMAIL_SMTP_HOST: "" })),
    /EMAIL_SMTP_HOST/
  );
  // Console provider (dev/testing) is accepted; disabled email is valid.
  assert.doesNotThrow(() => loadConfig(prodEnv({ EMAIL_ENABLED: "true", EMAIL_PROVIDER: "console" })));
  assert.doesNotThrow(() => loadConfig(prodEnv({ EMAIL_ENABLED: "false", EMAIL_PROVIDER: "smtp" })));
});

test("production: localhost auth domain is rejected (D6-P domain binding)", () => {
  assert.throws(() => loadConfig(prodEnv({ AUTH_DOMAIN: "http://localhost:3000" })), /AUTH_DOMAIN/);
  assert.throws(() => loadConfig(prodEnv({ AUTH_APP_URI: "http://localhost:3000" })), /AUTH_APP_URI/);
  // prodEnv fixture carries the required webhook key so only the domain fails.
});

test("production: WEBHOOK_DEV_ALLOW_PRIVATE rejected (SSRF policy)", () => {
  assert.throws(
    () => loadConfig(prodEnv({ WEBHOOK_DEV_ALLOW_PRIVATE: "true", WEBHOOK_ENCRYPTION_KEY: "01234567890123456789012345678901" })),
    /WEBHOOK_DEV_ALLOW_PRIVATE/
  );
});

test("development: unsafe combos remain allowed (ergonomic dev defaults)", () => {
  assert.doesNotThrow(() =>
    loadConfig({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/aegix",
      EMAIL_ENABLED: "true",
      EMAIL_PROVIDER: "smtp",
      AUTH_DOMAIN: "http://localhost:3000"
    })
  );
});

test("production: empty RPC failover URLs are treated as unset (compose default)", () => {
  const config = loadConfig(prodEnv({ RPC_PRIMARY_URL: "", RPC_SECONDARY_URL: "", RPC_TERTIARY_URL: "" }));
  assert.equal(config.RPC_PRIMARY_URL, undefined);
  assert.equal(config.RPC_SECONDARY_URL, undefined);
  assert.equal(config.RPC_TERTIARY_URL, undefined);
  assert.doesNotThrow(() => loadConfig(prodEnv({ RPC_PRIMARY_URL: "https://rpc.backup.example" })));
});
