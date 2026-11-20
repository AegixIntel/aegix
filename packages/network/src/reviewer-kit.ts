/**
 * Tooling for the people who review reputation claims. Everything here runs on
 * a reviewer's own machine and needs no database: a private key never leaves
 * it, and the operator only ever receives public keys and signed claims.
 *
 * The flow: each reviewer generates a key once and sends the public half to
 * the operator, who lists it in the policy file. A claim is drafted from its
 * evidence file (the digest is computed, never typed), each reviewer signs the
 * exact bytes `claimPayload` defines, and the operator turns the signed claim
 * and its evidence into the envelope `reputation:import` reads.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { parseChain, walletIdentity } from "./chains.js";
import { claimPayload, type ReputationClaim, type SignedClaim } from "./reputation.js";

export const LABELS = ["CONFIRMED_FRAUD", "CONFIRMED_LEGITIMATE_ACTIVITY"] as const;
/** The importer's limit; checked here so a reviewer learns before signing. */
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
const REVIEWER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function generateReviewerKey(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

export interface DraftInput {
  id: string; chain: string; address: string; label: string; sourceUrl: string;
  observedAt: string; expiresAt: string; datasetVersion: string;
}

/** Builds a claim from its evidence; rejects anything the importer would reject. */
export function draftClaim(input: DraftInput, evidence: Uint8Array, now = Date.now()): ReputationClaim {
  if (!CLAIM_ID.test(input.id)) throw new Error("Claim id: letters, digits and . _ : - only, up to 128 characters");
  const chain = parseChain(input.chain);
  walletIdentity(chain, input.address);
  if (!(LABELS as readonly string[]).includes(input.label)) throw new Error(`Label must be one of ${LABELS.join(", ")}`);
  let url: URL;
  try { url = new URL(input.sourceUrl); } catch { throw new Error("Source URL is not a URL"); }
  if (url.protocol !== "https:") throw new Error("Source URL must use HTTPS");
  const observed = Date.parse(input.observedAt);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires)) throw new Error("Dates must be ISO 8601");
  if (observed > now) throw new Error("observedAt is in the future");
  if (expires <= observed || expires <= now) throw new Error("expiresAt must be after observedAt and in the future");
  if (!input.datasetVersion.trim()) throw new Error("Dataset version required");
  if (evidence.length === 0 || evidence.length > MAX_EVIDENCE_BYTES) throw new Error("Evidence must be 1 byte to 1 MiB");
  return {
    id: input.id, chain, address: chain.startsWith("eip155:") ? input.address.toLowerCase() : input.address,
    label: input.label as ReputationClaim["label"], sourceUrl: url.toString(),
    evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
    observedAt: new Date(observed).toISOString(), expiresAt: new Date(expires).toISOString(),
    datasetVersion: input.datasetVersion
  };
}

/**
 * Adds one reviewer's signature. Existing signatures must still verify against
 * the claim as it stands, so a claim edited after someone signed it is refused
 * instead of collecting signatures over different bytes.
 */
export function signClaim(signed: SignedClaim, reviewerId: string, privatePem: string,
  knownPublicKeys: Readonly<Record<string, string>> = {}): SignedClaim {
  if (!REVIEWER_ID.test(reviewerId)) throw new Error("Reviewer id: lowercase letters, digits and . _ - only");
  if (signed.reviews.some(review => review.reviewerId === reviewerId)) throw new Error(`${reviewerId} has already signed this claim`);
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 private key required");
  const payload = claimPayload(signed.claim);
  for (const review of signed.reviews) {
    const pem = knownPublicKeys[review.reviewerId];
    if (pem && !verify(null, payload, createPublicKey(pem), Buffer.from(review.signature, "base64"))) {
      throw new Error(`${review.reviewerId}'s signature does not match this claim; it was changed after signing`);
    }
  }
  const signature = sign(null, payload, key).toString("base64");
  return { claim: signed.claim, reviews: [...signed.reviews, { reviewerId, signature }] };
}

export function importEnvelope(signed: SignedClaim, evidence: Uint8Array): { item: SignedClaim; evidenceBase64: string } {
  if (createHash("sha256").update(evidence).digest("hex") !== signed.claim.evidenceSha256) {
    throw new Error("Evidence file does not match the claim's digest");
  }
  return { item: signed, evidenceBase64: Buffer.from(evidence).toString("base64") };
}
