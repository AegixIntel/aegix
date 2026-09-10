import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_ENTITIES } from "@aegix/types";
import { COMMON_ENTITIES, COMMON_PROTOCOLS, CORRELATION_FAMILY_WEIGHTS } from "./config.js";

/**
 * The commonality sets are keyed by canonical entity name. If an entity is
 * renamed in the catalog and the set is not updated, the penalty silently
 * stops applying and shared use of a popular protocol starts looking like
 * correlation evidence. This test makes that failure loud.
 */
const CATALOG_NAMES = new Set(CANONICAL_ENTITIES.map((e) => e.name));

/** Native programs that are not in the catalog but are legitimate keys. */
const NATIVE_NAMES = new Set(["System Program", "Token Program", "Token-2022"]);

test("every COMMON_PROTOCOLS name resolves to a catalog entity", () => {
  for (const name of COMMON_PROTOCOLS) {
    assert.ok(
      CATALOG_NAMES.has(name) || NATIVE_NAMES.has(name),
      `"${name}" is in COMMON_PROTOCOLS but is neither a catalog entity nor a native program — the penalty it encodes is dead`
    );
  }
});

test("every COMMON_ENTITIES name resolves to a catalog entity", () => {
  for (const name of COMMON_ENTITIES) {
    assert.ok(
      CATALOG_NAMES.has(name) || NATIVE_NAMES.has(name),
      `"${name}" is in COMMON_ENTITIES but is not a catalog entity — the penalty it encodes is dead`
    );
  }
});

test("the highest-volume Solana protocols are all penalised as common", () => {
  // Sampled from finalized mainnet blocks: these dominate real transaction
  // flow, so shared use of them must never carry correlation weight.
  for (const name of ["Jupiter", "Raydium", "Pump.fun", "Meteora"]) {
    assert.ok(COMMON_PROTOCOLS.has(name), `${name} must be treated as common`);
  }
});

test("TEMPORAL_CORRELATION is weighted below direct value flow", () => {
  const weightOf = (family: string) => CORRELATION_FAMILY_WEIGHTS.find((w) => w.family === family)!.weight;
  assert.ok(weightOf("TEMPORAL_CORRELATION") < weightOf("FUNDING"));
  assert.ok(weightOf("TEMPORAL_CORRELATION") < weightOf("TRANSFER_RELATIONSHIP"));
});
