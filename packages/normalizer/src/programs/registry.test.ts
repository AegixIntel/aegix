import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_PROGRAMS, canonicalProgram } from "@aegix/types";
import { PROTOCOL_PARSERS, SEMANTICS_PROGRAM_IDS, parserFor, programLabelFor, protocolCategoryFor } from "./registry.js";

test("every instruction-semantics key resolves to a catalog program", () => {
  // A stale key is never consulted, so it would silently strip a protocol of
  // all its action mappings — the same silent failure mode as a dead address.
  for (const programId of SEMANTICS_PROGRAM_IDS) {
    assert.ok(
      canonicalProgram(programId),
      `${programId} has instruction semantics but is not in the canonical catalog — those mappings are dead`
    );
  }
});

test("the parser registry is exactly the catalog, with no extra identities", () => {
  assert.equal(PROTOCOL_PARSERS.length, CANONICAL_PROGRAMS.length);
  const catalogIds = new Set(CANONICAL_PROGRAMS.map((p) => p.programId));
  for (const parser of PROTOCOL_PARSERS) {
    assert.ok(catalogIds.has(parser.programId), `${parser.programId} is registered but not in the catalog`);
  }
});

test("labels and categories are taken from the catalog, never re-declared", () => {
  for (const program of CANONICAL_PROGRAMS) {
    assert.equal(programLabelFor(program.programId), program.label);
    assert.equal(protocolCategoryFor(program.programId), program.category);
  }
});

test("instruction-data matching is scoped to the owning program", () => {
  // A u8 index means nothing until the program is known: byte 49 is Token
  // Metadata's Transfer, and must not be read as an action for a program that
  // does not use that encoding.
  const tokenMetadata = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  const magicEden = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";
  const transferIx = "6XfYLU3"; // leading byte 49

  assert.deepEqual(parserFor(tokenMetadata)!.parse({ programId: tokenMetadata, program: "x", data: transferIx }), { actionType: "TRANSFER" });
  // Magic Eden has no u8 map, so the same bytes must not yield TRANSFER.
  const meAction = parserFor(magicEden)!.parse({ programId: magicEden, program: "x", data: transferIx });
  assert.notEqual(meAction?.actionType, "TRANSFER");
});

test("an unknown program has no parser at all", () => {
  assert.equal(parserFor("H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a"), null);
});

test("u8 instruction maps only contain evidence-backed indices", () => {
  // A wrong Anchor method name is inert (its digest matches nothing), but a
  // wrong u8 index invents an action for real instruction data. These maps
  // are therefore restricted to indices observed on mainnet, or bracketed
  // between two observed indices in the same contiguous enum run.
  const tokenMetadata = PROTOCOL_PARSERS.find((p) => p.programId === "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")!;
  const admitted = new Set([15, 33, 41, 42, 43, 44, 45, 46, 47, 49]);
  const mapped = Object.keys(tokenMetadata.byteActions ?? {}).map(Number).sort((a, b) => a - b);
  assert.deepEqual(mapped, [...admitted].sort((a, b) => a - b));

  // Indices recalled from documentation but never observed across 590 sampled
  // mainnet transactions must stay unmapped and fall through to the fallback.
  for (const unobserved of [0, 1, 10, 11, 16, 18, 22, 29, 50, 52, 53]) {
    assert.equal(tokenMetadata.byteActions?.[unobserved], undefined, `index ${unobserved} was never observed and must not be mapped`);
  }

  const raydium = PROTOCOL_PARSERS.find((p) => p.programId === "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")!;
  assert.deepEqual(Object.keys(raydium.byteActions ?? {}).map(Number).sort((a, b) => a - b), [9, 11]);
});

test("only programs with an established u8 encoding carry a u8 map", () => {
  // Byte-zero must never be read as an action before the program is known to
  // use that encoding.
  const withByteMaps = PROTOCOL_PARSERS.filter((p) => p.byteActions).map((p) => p.programId);
  assert.deepEqual(withByteMaps.sort(), [
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"   // Metaplex Token Metadata
  ].sort());
});
