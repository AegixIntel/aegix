import { createHash, createPublicKey, verify } from "node:crypto";
import { walletIdentity, type NetworkChain } from "./chains.js";

export interface ReputationClaim {
  id: string;
  chain: NetworkChain;
  address: string;
  label: "CONFIRMED_FRAUD" | "CONFIRMED_LEGITIMATE_ACTIVITY";
  sourceUrl: string;
  evidenceSha256: string;
  observedAt: string;
  expiresAt: string;
  datasetVersion: string;
}
export interface SignedClaim {
  claim: ReputationClaim;
  reviews: Array<{ reviewerId: string; signature: string }>;
}
export interface ValidationPolicy {
  /** Operator-controlled Ed25519 public keys; never supplied by API clients. */
  reviewers: Readonly<Record<string, string>>;
  revokedClaimIds: ReadonlySet<string>;
  datasetVersion: string;
  quorum: number;
}

/** Stable domain-separated payload for external review tooling. */
export function claimPayload(claim: ReputationClaim): Buffer {
  return Buffer.from(JSON.stringify([
    "AEGIX_REPUTATION_CLAIM_V1", claim.id, walletIdentity(claim.chain, claim.address),
    claim.label, claim.sourceUrl, claim.evidenceSha256, claim.observedAt, claim.expiresAt, claim.datasetVersion
  ]));
}

export function validateClaim(item: SignedClaim, evidence: Uint8Array, policy: ValidationPolicy, now: number): string[] {
  const { claim } = item;
  if (!Number.isFinite(now) || !Number.isSafeInteger(policy.quorum) || policy.quorum < 2) throw new Error("Invalid validation policy");
  if (!claim.id || !policy.datasetVersion || claim.datasetVersion !== policy.datasetVersion || policy.revokedClaimIds.has(claim.id)) throw new Error("Unapproved or revoked claim");
  if (!["CONFIRMED_FRAUD", "CONFIRMED_LEGITIMATE_ACTIVITY"].includes(claim.label)) throw new Error("Invalid claim label");
  if (new URL(claim.sourceUrl).protocol !== "https:") throw new Error("Evidence source must use HTTPS");
  const observed = Date.parse(claim.observedAt);
  const expires = Date.parse(claim.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now || expires <= now || expires <= observed) throw new Error("Claim is not current");
  if (!/^[0-9a-f]{64}$/.test(claim.evidenceSha256) || createHash("sha256").update(evidence).digest("hex") !== claim.evidenceSha256) throw new Error("Evidence digest mismatch");
  const payload = claimPayload(claim);
  const reviewers = new Set<string>();
  const keys = new Set<string>();
  for (const review of item.reviews) {
    const pem = Object.hasOwn(policy.reviewers, review.reviewerId) ? policy.reviewers[review.reviewerId] : undefined;
    if (!pem) continue;
    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") continue;
      const fingerprint = key.export({ type: "spki", format: "der" }).toString("hex");
      const signature = Buffer.from(review.signature, "base64");
      if (signature.length !== 64 || keys.has(fingerprint) || reviewers.has(review.reviewerId)) continue;
      if (verify(null, payload, key, signature)) {
        reviewers.add(review.reviewerId);
        keys.add(fingerprint);
      }
    } catch { /* Invalid signatures/keys do not count toward quorum. */ }
  }
  if (reviewers.size < policy.quorum) throw new Error("Insufficient trusted reviews");
  return [...reviewers].sort();
}

/** A signed label is evidence, not a calibrated probability of future fraud. */
export function reputationReport(
  chain: NetworkChain, address: string,
  items: Array<{ item: SignedClaim; evidence: Uint8Array }>,
  policy: ValidationPolicy, now = Date.now()
) {
  const wallet = walletIdentity(chain, address);
  const accepted: Array<{ claim: ReputationClaim; reviewers: string[] }> = [];
  const rejected: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const { item, evidence } of items) {
    try {
      if (walletIdentity(item.claim.chain, item.claim.address) !== wallet) throw new Error("Claim belongs to another wallet");
      if (seen.has(item.claim.id)) throw new Error("Duplicate claim id");
      const reviewers = validateClaim(item, evidence, policy, now);
      seen.add(item.claim.id);
      accepted.push({ claim: item.claim, reviewers });
    } catch (error) {
      rejected.push({ id: item.claim.id, reason: error instanceof Error ? error.message : "Invalid claim" });
    }
  }
  const labels = new Set(accepted.map(entry => entry.claim.label));
  return {
    wallet, evaluatedAt: new Date(now).toISOString(), datasetVersion: policy.datasetVersion,
    status: labels.size > 1 ? "CONFLICTING_EVIDENCE" : accepted.length ? "VALIDATED_EVIDENCE" : "INSUFFICIENT_EVIDENCE",
    score: null, riskBand: null, confidence: null,
    reason: "A calibrated reputation model and held-out labelled evaluation are required before publishing a score.",
    accepted, rejected
  };
}
