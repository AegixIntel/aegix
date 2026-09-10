import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Entity,
  EntityAddress,
  EntityAddressRole,
  EntityMatch,
  EntityStatus,
  EntityType,
  NormalizedTransfer
} from "@aegix/types";
import { analyzePublicAttribution } from "./public-attribution.js";
import type { EntityRegistry } from "./entities.js";

const WALLET = "walletA";

function entity(id: string, name: string, entityType: EntityType, status: EntityStatus = "VERIFIED"): Entity {
  return {
    id,
    name,
    entityType,
    description: null,
    status,
    defaultConfidence: 0.9,
    sourceType: "test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function address(
  entityId: string,
  addr: string,
  opts: { role?: EntityAddressRole; status?: EntityStatus; evidenceSource?: string | null } = {}
): EntityAddress {
  return {
    id: `addr-${addr}`,
    entityId,
    chain: "solana",
    address: addr,
    label: null,
    confidence: 0.9,
    evidenceSource: opts.evidenceSource ?? null,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    status: opts.status ?? "VERIFIED",
    addressRole: opts.role ?? "UNKNOWN_ROLE",
    deprecatedAt: null,
    notes: null
  };
}

function directTransfer(counterparty: string): NormalizedTransfer {
  return {
    chain: "solana",
    transactionId: `tx-${counterparty}`,
    timestamp: "2026-01-01T00:00:00Z",
    fromAddress: WALLET,
    toAddress: counterparty,
    assetType: "SOL",
    mint: null,
    amountRaw: "1000000000",
    amountNormalized: 1,
    transferType: "TRANSFER"
  };
}

function match(e: Entity, addr: string, confidence = 0.9): EntityMatch {
  return { entity: e, address: addr, confidence };
}

test("no entity matches means no public attribution", () => {
  const result = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [],
    matches: [],
    registry: { entities: [], addresses: [] }
  });

  assert.equal(result.signals.length, 0);
  assert.equal(result.publicAttributionExposure, 0);
});

test("using a DEX program attributes nothing", () => {
  const dex = entity("e-dex", "Test DEX", "DEX");
  const registry: EntityRegistry = { entities: [dex], addresses: [address(dex.id, "dexProgram", { role: "PROGRAM" })] };

  const result = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [],
    matches: [match(dex, "dexProgram")],
    registry
  });

  assert.equal(result.signals.length, 0, "a shared protocol must not attribute the operator");
  assert.equal(result.publicAttributionExposure, 0);
  assert.equal(result.attributions[0]!.directCounterparty, false);
  assert.ok(result.attributions[0]!.weight < 40, `got ${result.attributions[0]!.weight}`);
});

test("a verified custodial deposit address is the strongest attribution surface", () => {
  const cex = entity("e-cex", "Test Exchange", "CENTRALIZED_EXCHANGE");
  const registry: EntityRegistry = {
    entities: [cex],
    addresses: [address(cex.id, "depositAddr", { role: "DEPOSIT", evidenceSource: "https://example.test/proof" })]
  };

  const result = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [directTransfer("depositAddr")],
    matches: [match(cex, "depositAddr")],
    registry
  });

  const signal = result.signals.find((s) => s.type === "CUSTODIAL_DEPOSIT_ADDRESS_USE");
  assert.ok(signal, "expected a custodial deposit signal");
  assert.equal(signal.category, "PUBLIC_ATTRIBUTION");
  assert.ok(result.publicAttributionExposure >= 90, `got ${result.publicAttributionExposure}`);
  assert.equal(result.attributions[0]!.directCounterparty, true);
});

test("a publicly labelled organisation counterparty attributes without claiming identity", () => {
  const org = entity("e-org", "Public Foundation", "PUBLIC_ORGANIZATION", "PROBABLE");
  const registry: EntityRegistry = {
    entities: [org],
    addresses: [address(org.id, "orgAddr", { status: "PROBABLE" })]
  };

  const result = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [directTransfer("orgAddr")],
    matches: [match(org, "orgAddr")],
    registry
  });

  const signal = result.signals.find((s) => s.type === "PUBLICLY_ATTRIBUTED_COUNTERPARTY");
  assert.ok(signal, "expected a public counterparty signal");
  assert.ok(!/owns|belongs to|identified as/i.test(signal.summary), "summary must not assert ownership");
  assert.ok(result.publicAttributionExposure >= 40);
});

test("an unverified label attributes far less than a verified one", () => {
  const named = entity("e-w", "Named Wallet", "KNOWN_WALLET", "UNVERIFIED");
  const registry: EntityRegistry = {
    entities: [named],
    addresses: [address(named.id, "namedAddr", { status: "UNVERIFIED" })]
  };

  const result = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [directTransfer("namedAddr")],
    matches: [match(named, "namedAddr")],
    registry
  });

  assert.equal(result.signals.length, 0, "unverified labels must not raise attribution signals");
  assert.ok(result.attributions[0]!.weight < 40, `got ${result.attributions[0]!.weight}`);
});

test("an address-level status overrides the entity default", () => {
  const cex = entity("e-cex", "Test Exchange", "CENTRALIZED_EXCHANGE", "VERIFIED");
  const registry: EntityRegistry = {
    entities: [cex],
    addresses: [address(cex.id, "oldAddr", { role: "HOT_WALLET", status: "DEPRECATED" })]
  };

  const result = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [directTransfer("oldAddr")],
    matches: [match(cex, "oldAddr")],
    registry
  });

  assert.equal(result.attributions[0]!.entityStatus, "DEPRECATED");
  assert.equal(result.signals.length, 0);
});

test("multiple attributions add a bounded convergence bonus", () => {
  const cex = entity("e-cex", "Test Exchange", "CENTRALIZED_EXCHANGE");
  const org = entity("e-org", "Public Foundation", "PUBLIC_ORGANIZATION");
  const registry: EntityRegistry = {
    entities: [cex, org],
    addresses: [address(cex.id, "depositAddr", { role: "DEPOSIT" }), address(org.id, "orgAddr")]
  };

  const single = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [directTransfer("orgAddr")],
    matches: [match(org, "orgAddr")],
    registry
  });
  const both = analyzePublicAttribution({
    walletAddress: WALLET,
    transfers: [directTransfer("depositAddr"), directTransfer("orgAddr")],
    matches: [match(cex, "depositAddr"), match(org, "orgAddr")],
    registry
  });

  assert.ok(both.publicAttributionExposure > single.publicAttributionExposure);
  assert.ok(both.publicAttributionExposure <= 100);
  assert.equal(both.signals.length, 2);
});

test("attributions are ordered strongest first and deterministic", () => {
  const cex = entity("e-cex", "Test Exchange", "CENTRALIZED_EXCHANGE");
  const dex = entity("e-dex", "Test DEX", "DEX");
  const registry: EntityRegistry = {
    entities: [cex, dex],
    addresses: [address(cex.id, "depositAddr", { role: "DEPOSIT" }), address(dex.id, "dexProgram", { role: "PROGRAM" })]
  };
  const input = {
    walletAddress: WALLET,
    transfers: [directTransfer("depositAddr")],
    matches: [match(dex, "dexProgram"), match(cex, "depositAddr")],
    registry
  };

  const first = analyzePublicAttribution(input);
  const second = analyzePublicAttribution(input);

  assert.equal(first.attributions[0]!.address, "depositAddr");
  assert.deepEqual(first.attributions, second.attributions);
});
