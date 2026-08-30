import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSeedEntries, type SeedEntry } from "./seed-entities.js";

const VALID_ADDRESS = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function baseEntry(overrides: Partial<SeedEntry> = {}): SeedEntry {
  return {
    name: "Test Protocol",
    entityType: "DEX",
    description: "test",
    status: "VERIFIED",
    confidence: 0.95,
    sourceType: "PROTOCOL_DOCUMENTATION",
    addresses: [
      {
        address: VALID_ADDRESS,
        label: "Test",
        confidence: 0.95,
        status: "VERIFIED",
        evidenceSource: "https://example.com/docs"
      }
    ],
    ...overrides
  };
}

test("accepts a valid seed entry", () => {
  assert.deepEqual(validateSeedEntries([baseEntry()]), []);
});

test("rejects invalid Solana addresses", () => {
  const problems = validateSeedEntries([
    baseEntry({ addresses: [{ address: "not-a-valid-address!", label: "x", confidence: 0.5, status: "VERIFIED", evidenceSource: "s" }] })
  ]);
  assert.ok(problems.some((p) => p.includes("invalid Solana address")));
});

test("rejects duplicate program IDs across entities", () => {
  const problems = validateSeedEntries([
    baseEntry({ name: "A" }),
    baseEntry({ name: "B" })
  ]);
  assert.ok(problems.some((p) => p.includes("claimed by both")));
});

test("rejects missing evidence source", () => {
  const problems = validateSeedEntries([
    baseEntry({ addresses: [{ address: VALID_ADDRESS, label: "x", confidence: 0.5, status: "VERIFIED", evidenceSource: "" }] })
  ]);
  assert.ok(problems.some((p) => p.includes("missing evidenceSource")));
});

test("rejects confidence out of range", () => {
  const problems = validateSeedEntries([baseEntry({ confidence: 1.5 })]);
  assert.ok(problems.some((p) => p.includes("out of range")));
});

test("rejects invalid verification status", () => {
  const problems = validateSeedEntries([
    baseEntry({ status: "MAYBE_REAL" as SeedEntry["status"] })
  ]);
  assert.ok(problems.some((p) => p.includes("invalid status")));
});

test("rejects empty entity name", () => {
  const problems = validateSeedEntries([baseEntry({ name: "  " })]);
  assert.ok(problems.some((p) => p.includes("empty name")));
});
