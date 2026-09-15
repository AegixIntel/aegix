import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { walletIdentity } from "./chains.js";
import { indexBatch, type BlockSource, type IndexCheckpoint, type IndexStore } from "./indexer.js";
import { createBlockSource } from "./rpc.js";
import { claimPayload, reputationReport, validateClaim, type ReputationClaim, type ValidationPolicy } from "./reputation.js";
import { validateTransfer } from "./economics.js";

const address = "11111111111111111111111111111111";
test("wallet identities isolate networks and normalize EVM addresses only", () => {
  const evm = `0x${"Ab".repeat(20)}`;
  assert.equal(walletIdentity("eip155:1", evm), `eip155:1:${evm.toLowerCase()}`);
  assert.notEqual(walletIdentity("eip155:1", evm), walletIdentity("eip155:8453", evm));
  assert.equal(walletIdentity("solana:mainnet", address), `solana:mainnet:${address}`);
  assert.throws(() => walletIdentity("solana:mainnet", "1".repeat(33)));
  assert.throws(() => walletIdentity("eip155:1", address));
});

function fixture() {
  let checkpoint: IndexCheckpoint = { nextHeight: 10, lastHeight: 9, lastHash: "h9" };
  let commits = 0;
  const store: IndexStore = {
    checkpoint: async () => ({ ...checkpoint }),
    commit: async (_chain, _expected, next, blocks) => {
      commits++;
      const last = blocks.at(-1);
      checkpoint = { nextHeight: next, lastHeight: last?.height ?? checkpoint.lastHeight, lastHash: last?.hash ?? checkpoint.lastHash };
    }
  };
  const source: BlockSource = {
    chain: "solana:mainnet", verifyNetwork: async () => {}, finalizedHeight: async () => 12,
    firstAvailableHeight: async () => 0, heights: async () => [10, 12],
    block: async slot => ({ chain: "solana:mainnet", height: slot, hash: `h${slot}`,
      parentHeight: slot === 10 ? 9 : 10, parentHash: slot === 10 ? "h9" : "h10", raw: {} })
  };
  return { source, store, cursor: () => checkpoint.nextHeight, commits: () => commits };
}
test("global scan persists produced blocks across skipped slots and resumes", async () => {
  const f = fixture();
  assert.equal((await indexBatch(f.source, f.store, 10)).indexed, 2);
  assert.equal(f.cursor(), 13);
  assert.equal((await indexBatch(f.source, f.store, 10)).indexed, 0);
  assert.equal(f.commits(), 1);
});
test("RPC errors never advance the checkpoint", async () => {
  const f = fixture();
  const block = f.source.block;
  f.source.block = async slot => { if (slot === 12) throw new Error("unavailable"); return block(slot); };
  await assert.rejects(indexBatch(f.source, f.store, 10), /unavailable/);
  assert.equal(f.cursor(), 10);
  assert.equal(f.commits(), 0);
});
test("finalized parent mismatch halts indexing", async () => {
  const f = fixture();
  const block = f.source.block;
  f.source.block = async slot => ({ ...await block(slot), parentHash: "wrong" });
  await assert.rejects(indexBatch(f.source, f.store, 10), /discontinuity/);
  assert.equal(f.commits(), 0);
});
test("pruned history does not masquerade as skipped slots", async () => {
  const f = fixture();
  f.source.firstAvailableHeight = async () => 11;
  await assert.rejects(indexBatch(f.source, f.store, 10), /Archive/);
  assert.equal(f.commits(), 0);
});
test("unsorted or duplicate block lists fail closed", async () => {
  const f = fixture();
  f.source.heights = async () => [10, 10];
  await assert.rejects(indexBatch(f.source, f.store, 10), /ordering/);
  assert.equal(f.commits(), 0);
});
test("invalid batch bounds are rejected before fetching", async () => {
  const f = fixture();
  await assert.rejects(indexBatch(f.source, f.store, 10, 0));
  await assert.rejects(indexBatch(f.source, f.store, 10, 257));
  await assert.rejects(indexBatch(f.source, f.store, Number.MAX_SAFE_INTEGER + 1));
});
test("EVM source verifies chain ID and fetches full finalized blocks", async () => {
  const calls: string[] = [];
  const source = createBlockSource("eip155:8453", async (method, params) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x2105";
    if (params[0] === "finalized") return { number: "0xa" };
    assert.deepEqual(params, ["0xa", true]);
    return { number: "0xa", hash: "h10", parentHash: "h9", transactions: [] };
  });
  await source.verifyNetwork();
  assert.equal(await source.finalizedHeight(), 10);
  assert.deepEqual(await source.heights(9, 10), [9, 10]);
  assert.equal((await source.block(10)).parentHeight, 9);
  assert.equal(calls.length, 3);
});
test("wrong network and null blocks are rejected", async () => {
  const source = createBlockSource("eip155:1", async () => null);
  await assert.rejects(source.verifyNetwork(), /network/);
  await assert.rejects(source.block(10), /object/);
});

test("Solana verifies the full genesis hash and requests finalized versioned transactions", async () => {
  const source = createBlockSource("solana:mainnet", async (method, params) => {
    if (method === "getGenesisHash") return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    assert.equal(method, "getBlock");
    assert.deepEqual(params, [10, { commitment: "finalized", encoding: "jsonParsed", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 1 }]);
    return { blockhash: "h10", previousBlockhash: "h9", parentSlot: 9, transactions: [] };
  });
  await source.verifyNetwork();
  assert.equal((await source.block(10)).height, 10);
  await assert.rejects(createBlockSource("solana:mainnet", async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp").verifyNetwork());
});

function reviewed() {
  const evidence = Buffer.from("reviewed case evidence");
  const claim: ReputationClaim = {
    id: "case-1", chain: "solana:mainnet", address, label: "CONFIRMED_FRAUD",
    sourceUrl: "https://example.org/case-1", evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
    observedAt: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z", datasetVersion: "test-v1"
  };
  const pairs = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const reviewers = Object.fromEntries(pairs.map((pair, i) => [`r${i}`, pair.publicKey.export({ type: "spki", format: "pem" }).toString()]));
  const policy: ValidationPolicy = { reviewers, quorum: 2, revokedClaimIds: new Set(), datasetVersion: "test-v1" };
  const item = { claim, reviews: pairs.map((pair, i) => ({ reviewerId: `r${i}`, signature: sign(null, claimPayload(claim), pair.privateKey).toString("base64") })) };
  return { item, evidence, policy, now: Date.parse("2026-09-15T00:00:00Z") };
}
test("reputation accepts matching evidence with two trusted signatures without inventing a score", () => {
  const f = reviewed();
  assert.equal(validateClaim(f.item, f.evidence, f.policy, f.now).length, 2);
  const report = reputationReport("solana:mainnet", address, [f], f.policy, f.now);
  assert.equal(report.status, "VALIDATED_EVIDENCE");
  assert.equal(report.score, null);
  assert.equal(report.confidence, null);
});
test("tampered evidence, labels and expired or revoked claims are rejected", () => {
  const f = reviewed();
  assert.throws(() => validateClaim(f.item, Buffer.from("tampered"), f.policy, f.now), /digest/);
  assert.throws(() => validateClaim({ ...f.item, claim: { ...f.item.claim, label: "CONFIRMED_LEGITIMATE_ACTIVITY" } }, f.evidence, f.policy, f.now), /reviews/);
  assert.throws(() => validateClaim(f.item, f.evidence, f.policy, Date.parse("2027-01-01")), /current/);
  assert.throws(() => validateClaim(f.item, f.evidence, { ...f.policy, revokedClaimIds: new Set(["case-1"]) }, f.now), /revoked/);
});
test("duplicate reviewer keys cannot satisfy quorum", () => {
  const f = reviewed();
  f.item.reviews[1] = { reviewerId: "r1", signature: f.item.reviews[0]!.signature };
  assert.throws(() => validateClaim(f.item, f.evidence, { ...f.policy, reviewers: { r0: f.policy.reviewers.r0!, r1: f.policy.reviewers.r0! } }, f.now), /reviews/);
});
test("missing evidence does not imply a clean wallet", () => {
  const f = reviewed();
  const result = reputationReport("solana:mainnet", address, [], f.policy, f.now);
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.riskBand, null);
});
test("ledger requires exact atomic amounts and distinct accounts", () => {
  const input = { eventKey: "event-1", debitAccount: "treasury", creditAccount: "researcher", amount: "9007199254740993", purpose: "RESEARCH_BOUNTY" as const, evidenceRef: "case-1" };
  assert.equal(validateTransfer(input), 9007199254740993n);
  for (const amount of ["0", "-1", "1.1", "1e5", "01", "1".repeat(79)]) assert.throws(() => validateTransfer({ ...input, amount }));
  assert.throws(() => validateTransfer({ ...input, creditAccount: "treasury" }));
});
