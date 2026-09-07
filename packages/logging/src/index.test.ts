import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger, walletRef, type AegixLogger } from "./index.js";

interface Capture {
  logger: AegixLogger;
  lines: string[];
  restore(): void;
}

function capture(level: "info" | "error" = "info"): Capture {
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const sink = (chunk: string | Uint8Array) => {
    lines.push(String(chunk).trim());
    return true;
  };
  process.stdout.write = sink;
  process.stderr.write = sink;
  const logger = createLogger({ LOG_LEVEL: "debug" }, { service: "test" });
  return {
    logger,
    lines,
    restore() {
      process.stdout.write = originalWrite;
      process.stderr.write = originalErr;
    }
  };
}

test("logs structured JSON with level and timestamp", () => {
  const { logger, lines, restore } = capture();
  logger.info("hello", { stage: "fetch" });
  restore();
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!);
  assert.equal(record.level, "info");
  assert.equal(record.msg, "hello");
  assert.equal(record.service, "test");
  assert.equal(record.stage, "fetch");
  assert.ok(typeof record.timestamp === "string");
});

test("respects log level filtering", () => {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    lines.push(String(chunk).trim());
    return true;
  };
  const logger = createLogger({ LOG_LEVEL: "warn" });
  logger.debug("hidden");
  logger.info("hidden too");
  logger.warn("shown");
  process.stdout.write = original;
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes('"msg":"shown"'));
});

test("child logger binds trace ids", () => {
  const { logger, lines, restore } = capture();
  const child = logger.child({ analysisId: "a-1", jobId: "j-1" });
  child.info("stage done", { stage: "scoring", durationMs: 12 });
  restore();
  const record = JSON.parse(lines[0]!);
  assert.equal(record.analysisId, "a-1");
  assert.equal(record.jobId, "j-1");
  assert.equal(record.durationMs, 12);
});

test("walletRef shortens and hashes without leaking full address", () => {
  const address = "7iDEKWJMprnBCLj8ZnSJxxa9TvMN83YCzrqpAU4Sp9KU";
  const ref = walletRef(address);
  assert.equal(ref.walletShort, "7iDEKW…p9KU");
  assert.ok(!ref.walletShort.includes(address.slice(6, -4)));
  assert.match(ref.walletHash, /^[0-9a-f]{16}$/);
});

test("redacts secret fields and URL query strings", () => {
  const { logger, lines, restore } = capture();
  logger.info("provider failed", {
    rpcUrl: "https://rpc.example.com/path?api-key=sensitive-value",
    authorization: "Bearer sensitive-value",
    nested: { password: "sensitive-value" }
  });
  restore();
  assert.doesNotMatch(lines[0]!, /sensitive-value/);
  assert.match(lines[0]!, /REDACTED/);
});

test("retains non-secret API key identifiers for operational tracing", () => {
  const { logger, lines, restore } = capture();
  logger.info("developer request", {
    apiKeyId: "key-row-42",
    apiKeyPrefix: "aegix_live_abc123",
    apiKey: "full-secret-value"
  });
  restore();
  assert.match(lines[0]!, /key-row-42/);
  assert.match(lines[0]!, /aegix_live_abc123/);
  assert.doesNotMatch(lines[0]!, /full-secret-value/);
});
