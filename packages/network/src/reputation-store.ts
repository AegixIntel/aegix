import { createHash } from "node:crypto";
import type postgres from "postgres";
import { CHAINS, walletIdentity, type NetworkChain } from "./chains.js";
import { claimPayload, reputationReport, validateClaim, type SignedClaim, type ValidationPolicy } from "./reputation.js";

export function createReputationStore(sql: postgres.Sql, policy: ValidationPolicy) {
  return {
    async importClaim(item: SignedClaim, evidence: Uint8Array, now = Date.now()) {
      if (evidence.byteLength > 1_048_576) throw new Error("Evidence exceeds 1 MiB");
      const reviewers = validateClaim(item, evidence, policy, now);
      const claim = item.claim;
      const address = CHAINS[claim.chain].family === "evm" ? claim.address.toLowerCase() : claim.address;
      const digest = createHash("sha256").update(claimPayload(claim)).digest("hex");
      return sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`reputation:${claim.id}`}, 0))`;
        const [existing] = await tx`select payload_digest, revoked_at from reputation_claims where id = ${claim.id}`;
        if (existing) {
          if (existing.revoked_at) throw new Error("Claim was revoked");
          if (existing.payload_digest !== digest) throw new Error("Claim ID already belongs to different evidence");
          return { replayed: true, reviewers };
        }
        await tx`insert into reputation_claims (id, chain, address, dataset_version, payload, evidence, payload_digest)
          values (${claim.id}, ${claim.chain}, ${address}, ${claim.datasetVersion},
            ${tx.json(JSON.parse(JSON.stringify(item)))}, ${Buffer.from(evidence)}, ${digest})`;
        return { replayed: false, reviewers };
      });
    },
    async revoke(id: string, reason: string) {
      if (!reason.trim() || reason.length > 1000) throw new Error("Revocation reason required (max 1000 characters)");
      const rows = await sql`update reputation_claims set revoked_at = coalesce(revoked_at, now()),
        revocation_reason = coalesce(revocation_reason, ${reason}) where id = ${id} returning id`;
      if (!rows.length) throw new Error("Claim not found");
    },
    async report(chain: NetworkChain, address: string, now = Date.now()) {
      walletIdentity(chain, address);
      const canonical = CHAINS[chain].family === "evm" ? address.toLowerCase() : address;
      const rows = await sql`select id, payload, evidence, revoked_at from reputation_claims
        where chain = ${chain} and address = ${canonical} and dataset_version = ${policy.datasetVersion}
        order by imported_at desc, id desc limit 101`;
      const revoked = new Set(policy.revokedClaimIds);
      for (const row of rows) if (row.revoked_at) revoked.add(row.id);
      // Revalidate on every read: key rotation, expiry and revocation take effect.
      return { ...reputationReport(chain, address, rows.slice(0, 100).map(row => ({ item: row.payload as SignedClaim,
        evidence: row.evidence as Buffer })), { ...policy, revokedClaimIds: revoked }, now),
        truncated: rows.length > 100 };
    }
  };
}
