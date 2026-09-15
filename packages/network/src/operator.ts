import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createReputationStore } from "./reputation-store.js";
import { readReputationPolicy } from "./policy.js";
import { createAexLedger } from "./economics.js";
import type { SignedClaim } from "./reputation.js";

/** Operator-only commands: possession of the DB credentials is required. */
async function main() {
  const [command, fileOrId, reason] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const sql = postgres(process.env.DATABASE_URL, { max: 2 });
  try {
    if (command === "reputation:import" || command === "reputation:revoke") {
      if (!process.env.REPUTATION_POLICY_FILE || !fileOrId) throw new Error("Policy and claim required");
      const store = createReputationStore(sql, await readReputationPolicy(process.env.REPUTATION_POLICY_FILE));
      if (command === "reputation:revoke") {
        await store.revoke(fileOrId, reason ?? "");
        console.log(JSON.stringify({ revoked: fileOrId }));
      } else {
        const envelope = JSON.parse(await readFile(fileOrId, "utf8")) as { item: SignedClaim; evidenceBase64: string };
        if (typeof envelope.evidenceBase64 !== "string" || envelope.evidenceBase64.length > 1_400_000) throw new Error("Invalid evidence");
        console.log(JSON.stringify(await store.importClaim(envelope.item, Buffer.from(envelope.evidenceBase64, "base64"))));
      }
      return;
    }
    if (command === "aex:transfer" && fileOrId) {
      console.log(JSON.stringify(await createAexLedger(sql).transfer(JSON.parse(await readFile(fileOrId, "utf8")))));
      return;
    }
    if (command === "aex:sandbox-open" && fileOrId) {
      if (process.env.AEX_MODE !== "sandbox" || process.env.NODE_ENV === "production") throw new Error("Sandbox funding is disabled");
      const { accountId, amount, eventKey } = JSON.parse(await readFile(fileOrId, "utf8"));
      if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256 ||
        typeof eventKey !== "string" || !eventKey.trim() || eventKey.length > 256 ||
        typeof amount !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(amount)) throw new Error("Invalid opening");
      await sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`aex-opening:${eventKey}`}, 0))`;
        const [prior] = await tx`select * from aex_openings where event_key = ${eventKey}`;
        if (prior) {
          if (prior.account_id !== accountId || prior.amount !== amount) throw new Error("Opening event conflict");
          return;
        }
        await tx`insert into aex_accounts (id, balance) values (${accountId}, ${amount})`;
        await tx`insert into aex_openings (event_key, account_id, amount, mode) values (${eventKey}, ${accountId}, ${amount}, 'SANDBOX')`;
      });
      console.log(JSON.stringify({ mode: "SANDBOX", accountId, amount }));
      return;
    }
    throw new Error("Unknown command");
  } finally { await sql.end(); }
}
main().catch(() => {
  console.error("Operator command failed. Check command inputs, policy, signatures, account balance and database availability.");
  process.exitCode = 1;
});
