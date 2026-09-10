import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_ENTITIES,
  CANONICAL_PROGRAMS,
  SEEDABLE_ENTITIES,
  base58ByteLength,
  canonicalProgram,
  isSolanaPublicKey,
  validateProgramCatalog,
  type CanonicalEntity
} from "./programs.js";

test("catalog passes structural validation", () => {
  assert.deepEqual(validateProgramCatalog(), []);
});

test("every program ID is a real 32-byte Solana public key", () => {
  // The regression this guards: a Tensor program ID of 42 characters that
  // passed every "valid base58 characters, length 32-44" check while
  // decoding to 31 bytes — so it could never match an on-chain program.
  for (const program of CANONICAL_PROGRAMS) {
    assert.equal(
      base58ByteLength(program.programId),
      32,
      `${program.entityName}/${program.label} (${program.programId}) is not 32 bytes`
    );
  }
});

test("base58ByteLength rejects non-base58 and wrong-size keys", () => {
  assert.equal(base58ByteLength("TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA"), 31);
  assert.equal(base58ByteLength("0OIl"), -1, "0, O, I and l are not in the base58 alphabet");
  assert.equal(base58ByteLength(""), -1);
  assert.equal(isSolanaPublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), true);
  assert.equal(isSolanaPublicKey("TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA"), false);
});

test("base58ByteLength handles leading-zero (leading '1') keys", () => {
  assert.equal(base58ByteLength("11111111111111111111111111111111"), 32, "System program is 32 zero bytes");
});

test("no program ID is claimed by two entities", () => {
  const seen = new Map<string, string>();
  for (const program of CANONICAL_PROGRAMS) {
    const previous = seen.get(program.programId);
    assert.equal(previous, undefined, `${program.programId} claimed by ${previous} and ${program.entityName}`);
    seen.set(program.programId, program.entityName);
  }
});

test("VERIFIED programs carry an evidence source", () => {
  for (const program of CANONICAL_PROGRAMS) {
    if (program.status === "VERIFIED") {
      assert.ok(program.evidenceSource.trim().length > 0, `${program.entityName}/${program.label}`);
    }
  }
});

test("addresses removed as unmatchable never come back", () => {
  // These five shipped as VERIFIED. Four decode to valid pubkeys with no
  // mainnet account; the fifth is not 32 bytes. All matched nothing, so the
  // protocols they claimed to cover were counted as unknown programs.
  const unmatchable = [
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VdjYdZyBf5byvVM",
    "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw",
    "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF",
    "TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA"
  ];
  for (const address of unmatchable) {
    assert.equal(canonicalProgram(address), null, `${address} is back in the catalog`);
  }
});

test("infrastructure programs are parsed but never seeded as entities", () => {
  // Every wallet touches memo/compression/oracles, so shared use of them is
  // not correlation evidence and they must not become attributable entities.
  const infrastructure = CANONICAL_ENTITIES.filter((e) => !e.seedAsEntity).map((e) => e.name);
  assert.ok(infrastructure.includes("Solana Program Library"));
  assert.ok(infrastructure.includes("Oracles"));
  for (const entity of SEEDABLE_ENTITIES) {
    assert.equal(entity.seedAsEntity, true);
  }
  assert.ok(SEEDABLE_ENTITIES.length < CANONICAL_ENTITIES.length);
});

test("Metaplex and Tensor program families are covered", () => {
  const labelsFor = (name: string) =>
    CANONICAL_PROGRAMS.filter((p) => p.entityName === name).map((p) => p.label).join(" | ");

  const metaplex = labelsFor("Metaplex");
  for (const expected of ["Token Metadata", "Bubblegum", "Candy Machine v3", "Candy Guard", "Auction House", "Core"]) {
    assert.ok(metaplex.includes(expected), `Metaplex missing ${expected}`);
  }

  const tensor = labelsFor("Tensor");
  for (const expected of ["Tensor Escrow", "Tensor Compressed NFT", "Tensor Bid", "Tensor Lock"]) {
    assert.ok(tensor.includes(expected), `Tensor missing ${expected}`);
  }
});

test("validateProgramCatalog reports injected problems", () => {
  const broken: CanonicalEntity[] = [
    {
      name: "Broken",
      entityType: "DEX",
      description: "fixture",
      status: "VERIFIED",
      confidence: 0.9,
      sourceType: "PROTOCOL_DOCUMENTATION",
      seedAsEntity: true,
      programs: [
        { programId: "TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA", label: "31 bytes", category: "DEX", status: "VERIFIED", confidence: 0.9, evidenceSource: "fixture" },
        { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", label: "no source", category: "DEX", status: "VERIFIED", confidence: 0.9, evidenceSource: "  " },
        { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", label: "duplicate", category: "DEX", status: "PROBABLE", confidence: 2, evidenceSource: "fixture" }
      ]
    }
  ];
  const problems = validateProgramCatalog(broken);
  assert.ok(problems.some((p) => p.includes("31 bytes, expected 32")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("missing evidenceSource")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("claimed by both")), problems.join("; "));
  assert.ok(problems.some((p) => p.includes("out of range")), problems.join("; "));
});
