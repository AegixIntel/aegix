import test from "node:test";
import assert from "node:assert/strict";
import { validateClaim } from "./reputation.js";
import { draftClaim, generateReviewerKey, importEnvelope, signClaim } from "./reviewer-kit.js";

const now = Date.parse("2026-11-20T00:00:00Z");
const evidence = Buffer.from("Court filing, case 123, page 4");
const input = { id: "case-1", chain: "eip155:1", address: `0x${"AB".repeat(20)}`, label: "CONFIRMED_FRAUD",
  sourceUrl: "https://example.org/case-1", observedAt: "2026-11-01T00:00:00Z", expiresAt: "2027-11-01T00:00:00Z",
  datasetVersion: "reviewed-v1" };

test("a drafted claim signed by a quorum passes the importer's own validation", () => {
  const a = generateReviewerKey();
  const b = generateReviewerKey();
  const claim = draftClaim(input, evidence, now);
  assert.equal(claim.address, input.address.toLowerCase());
  assert.match(claim.evidenceSha256, /^[0-9a-f]{64}$/);
  let signed = signClaim({ claim, reviews: [] }, "alice", a.privatePem);
  signed = signClaim(signed, "bob", b.privatePem, { alice: a.publicPem });
  const policy = { datasetVersion: "reviewed-v1", quorum: 2, revokedClaimIds: new Set<string>(),
    reviewers: { alice: a.publicPem, bob: b.publicPem } };
  assert.deepEqual(validateClaim(signed, evidence, policy, now), ["alice", "bob"]);
  const envelope = importEnvelope(signed, evidence);
  assert.equal(Buffer.from(envelope.evidenceBase64, "base64").toString(), evidence.toString());
});

test("drafting rejects what the importer would reject", () => {
  assert.throws(() => draftClaim({ ...input, label: "SUSPICIOUS" }, evidence, now), /Label/);
  assert.throws(() => draftClaim({ ...input, sourceUrl: "http://example.org" }, evidence, now), /HTTPS/);
  assert.throws(() => draftClaim({ ...input, address: "0x123" }, evidence, now), /Invalid EVM address/);
  assert.throws(() => draftClaim({ ...input, expiresAt: "2026-01-01T00:00:00Z" }, evidence, now), /expiresAt/);
  assert.throws(() => draftClaim({ ...input, observedAt: "2027-01-01T00:00:00Z" }, evidence, now), /future/);
  assert.throws(() => draftClaim(input, Buffer.alloc(0), now), /Evidence/);
  assert.throws(() => draftClaim(input, Buffer.alloc(1024 * 1024 + 1), now), /Evidence/);
});

test("signing refuses a second signature from the same reviewer and a claim changed after signing", () => {
  const a = generateReviewerKey();
  const b = generateReviewerKey();
  const signed = signClaim({ claim: draftClaim(input, evidence, now), reviews: [] }, "alice", a.privatePem);
  assert.throws(() => signClaim(signed, "alice", a.privatePem), /already signed/);
  const edited = { ...signed, claim: { ...signed.claim, label: "CONFIRMED_LEGITIMATE_ACTIVITY" as const } };
  assert.throws(() => signClaim(edited, "bob", b.privatePem, { alice: a.publicPem }), /changed after signing/);
});

test("an envelope is refused when the evidence file is not the one the claim names", () => {
  const signed = signClaim({ claim: draftClaim(input, evidence, now), reviews: [] }, "alice", generateReviewerKey().privatePem);
  assert.throws(() => importEnvelope(signed, Buffer.from("different file")), /does not match/);
});
