/**
 * Reviewer CLI. Runs offline; needs no database and no credentials.
 *
 *   keygen   --id <reviewer> --out <dir>
 *   draft    --id <claim> --chain <chain> --address <addr> --label <label>
 *            --source-url <https url> --evidence <file> --dataset <version>
 *            [--observed <ISO>] --expires <ISO> --out <claim.json>
 *   sign     <claim.json> --reviewer <id> --key <private.pem> [--policy <policy.json>]
 *   verify   <claim.json> --evidence <file> --policy <policy.json>
 *   envelope <claim.json> --evidence <file> --out <import.json>
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readReputationPolicy } from "./policy.js";
import { validateClaim, type SignedClaim } from "./reputation.js";
import { draftClaim, generateReviewerKey, importEnvelope, signClaim } from "./reviewer-kit.js";

function flag(name: string, required = true): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (required) throw new Error(`--${name} is required`);
    return "";
  }
  return value;
}
const readSigned = async (file: string) => JSON.parse(await readFile(file, "utf8")) as SignedClaim;
const write = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === "keygen") {
    const id = flag("id");
    const dir = flag("out");
    await mkdir(dir, { recursive: true });
    const { privatePem, publicPem } = generateReviewerKey();
    const privatePath = path.join(dir, `${id}.key.pem`);
    // wx: never overwrite an existing key.
    await writeFile(privatePath, privatePem, { flag: "wx", mode: 0o600 });
    await chmod(privatePath, 0o600);
    await writeFile(path.join(dir, `${id}.pub.pem`), publicPem, { flag: "wx" });
    console.log(JSON.stringify({ reviewer: id, privateKey: privatePath, publicKey: path.join(dir, `${id}.pub.pem`),
      policyEntry: { [id]: publicPem }, note: "Keep the private key on this machine. Send only the .pub.pem to the operator." }, null, 2));
    return;
  }
  if (command === "draft") {
    const evidence = await readFile(flag("evidence"));
    const claim = draftClaim({ id: flag("id"), chain: flag("chain"), address: flag("address"), label: flag("label"),
      sourceUrl: flag("source-url"), observedAt: flag("observed", false) || new Date().toISOString(),
      expiresAt: flag("expires"), datasetVersion: flag("dataset") }, evidence);
    await write(flag("out"), { claim, reviews: [] } satisfies SignedClaim);
    console.log(JSON.stringify({ drafted: flag("out"), claim }, null, 2));
    return;
  }
  if (command === "sign" && file) {
    const policyFile = flag("policy", false);
    const known = policyFile ? (await readReputationPolicy(policyFile)).reviewers : {};
    const signed = signClaim(await readSigned(file), flag("reviewer"), await readFile(flag("key"), "utf8"), known);
    await writeFile(file, `${JSON.stringify(signed, null, 2)}\n`);
    console.log(JSON.stringify({ signed: file, reviewers: signed.reviews.map(review => review.reviewerId) }));
    return;
  }
  if (command === "verify" && file) {
    const reviewers = validateClaim(await readSigned(file), await readFile(flag("evidence")),
      await readReputationPolicy(flag("policy")), Date.now());
    console.log(JSON.stringify({ valid: true, reviewers }));
    return;
  }
  if (command === "envelope" && file) {
    await write(flag("out"), importEnvelope(await readSigned(file), await readFile(flag("evidence"))));
    console.log(JSON.stringify({ envelope: flag("out") }));
    return;
  }
  throw new Error("Usage: reviewer keygen | draft | sign <claim.json> | verify <claim.json> | envelope <claim.json>");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
