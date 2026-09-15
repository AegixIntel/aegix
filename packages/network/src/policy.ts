import { readFile } from "node:fs/promises";
import { createPublicKey } from "node:crypto";
import type { ValidationPolicy } from "./reputation.js";
import { record } from "./projection.js";

export async function readReputationPolicy(path: string): Promise<ValidationPolicy> {
  const parsed = record(JSON.parse(await readFile(path, "utf8")));
  const reviewers = record(parsed.reviewers);
  if (typeof parsed.datasetVersion !== "string" || !parsed.datasetVersion.trim() ||
    typeof parsed.quorum !== "number" || !Number.isSafeInteger(parsed.quorum) || parsed.quorum < 2) throw new Error("Invalid reputation policy");
  const keys = new Set<string>();
  for (const pem of Object.values(reviewers)) {
    if (typeof pem !== "string") throw new Error("Reviewer public key required");
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 reviewers required");
    keys.add(key.export({ type: "spki", format: "der" }).toString("hex"));
  }
  if (keys.size < parsed.quorum) throw new Error("Insufficient distinct reviewer keys");
  if (!Array.isArray(parsed.revokedClaimIds) || parsed.revokedClaimIds.some(id => typeof id !== "string")) throw new Error("Revocation list required");
  return { datasetVersion: parsed.datasetVersion, quorum: parsed.quorum,
    reviewers: reviewers as Record<string, string>, revokedClaimIds: new Set(parsed.revokedClaimIds as string[]) };
}
