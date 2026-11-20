import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, createSessionRepo, createDeveloperApiKeyRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { buildServer } from "../apps/api/src/server.js";
import { generateApiKey } from "../apps/api/src/developer-keys.js";
import { createIndexStore, createNetworkQuery, createReputationStore, readReputationPolicy, claimPayload, createAexLedger } from "../packages/network/src/index.js";
import type { ReputationClaim } from "../packages/network/src/reputation.js";

async function main() {
const url = process.env.NETWORK_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith("/network_test")) throw new Error("Explicit network_test scratch database required");
const sql = createDb(url);
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  const [existing] = await sql`select to_regclass('profiles') as existing`;
  assert.equal(existing?.existing, null, "requires a fresh scratch database; never resets existing data");
  const migrations = (await readdir("packages/database/migrations")).filter(file => file.endsWith(".sql")).sort();
  for (const file of migrations) await sql.begin(async tx => { await tx.unsafe(await readFile(`packages/database/migrations/${file}`, "utf8")); });

  const keyPairs = [generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519")];
  const temp = await mkdtemp(path.join(tmpdir(), "aegix-policy-test-"));
  const policyPath = path.join(temp, "policy.json");
  await writeFile(policyPath, JSON.stringify({ datasetVersion: "test-only-v1", quorum: 2, revokedClaimIds: [],
    reviewers: Object.fromEntries(keyPairs.map((key, i) => [`reviewer-${i}`, key.publicKey.export({ type: "spki", format: "pem" })])) }));
  const policy = await readReputationPolicy(policyPath);
  const userId = randomUUID();
  const otherId = randomUUID();
  await sql`insert into profiles (id) values (${userId}), (${otherId})`;
  const session = randomUUID();
  const otherSession = randomUUID();
  for (const [user, token] of [[userId, session], [otherId, otherSession]]) await createSessionRepo(sql).create({ userId: user!, tokenHash: createHash("sha256").update(token!).digest("hex"), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const devKey = generateApiKey();
  await createDeveloperApiKeyRepo(sql).create({ userId, name: "network-e2e", keyPrefix: devKey.keyPrefix, keyHash: devKey.keyHash, scopes: ["intelligence:read"], expiresAt: null });

  const chain = "solana:mainnet";
  const address = "11111111111111111111111111111111";
  const store = createIndexStore(sql);
  const initial = await store.checkpoint(chain, 10);
  const transaction = (signature: string) => ({ transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: address, signer: true }], instructions: [] } }, meta: { err: null, fee: 0 } });
  await store.commit(chain, initial, 11, [{ chain, height: 10, hash: "fixture-h10", parentHeight: 9, parentHash: "fixture-h9",
    raw: { blockTime: 1700000000, transactions: [transaction("fixture-tx1"), transaction("fixture-tx2"), transaction("fixture-tx3")] } }]);
  assert.equal(await createNetworkQuery(sql).backfill(chain), 0);
  const evidence = Buffer.from("Synthetic test evidence, not a real fraud allegation");
  const claim: ReputationClaim = { id: "test-case-1", chain, address, label: "CONFIRMED_LEGITIMATE_ACTIVITY", sourceUrl: "https://example.org/test-only",
    evidenceSha256: createHash("sha256").update(evidence).digest("hex"), observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), datasetVersion: policy.datasetVersion };
  const item = { claim, reviews: keyPairs.map((key, i) => ({ reviewerId: `reviewer-${i}`, signature: sign(null, claimPayload(claim), key.privateKey).toString("base64") })) };
  const reputation = createReputationStore(sql, policy);
  await reputation.importClaim(item, evidence);
  assert.equal((await reputation.importClaim(item, evidence)).replayed, true);
  await assert.rejects(reputation.importClaim(item, Buffer.from("tampered")));

  await sql`insert into aex_accounts (id, balance) values ('treasury', 100), (${`user:${userId}`}, 0), (${`user:${otherId}`}, 0)`;
  await createAexLedger(sql).transfer({ eventKey: "test-payout", debitAccount: "treasury", creditAccount: `user:${userId}`, amount: "25", purpose: "RESEARCH_BOUNTY", evidenceRef: claim.id });
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: url, REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    ENABLE_NETWORK_API: "true", REPUTATION_POLICY_FILE: policyPath, ENABLE_LEGACY_AUTH: "false", ENABLE_WEBHOOK_DELIVERY: "false", LOG_LEVEL: "fatal" });
  app = await buildServer({ config });
  const get = (route: string, token = session) => app!.inject({ method: "GET", url: route, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await app.inject({ method: "GET", url: "/v1/network/status" })).statusCode, 401);
  const first = await get(`/v1/network/history/${chain}/${address}?limit=2`);
  assert.equal(first.statusCode, 200, first.body);
  const firstData = first.json().data;
  assert.equal(firstData.transactions.length, 2);
  const cursor = firstData.nextCursor;
  const next = await get(`/v1/network/history/${chain}/${address}?limit=2&beforeHeight=${cursor.height}&beforePosition=${cursor.position}`);
  assert.equal(next.json().data.transactions.length, 1);
  assert.equal(next.json().data.transactions[0].tx_id, "fixture-tx1");
  assert.equal((await get(`/v1/network/history/${chain}/${address}?beforeHeight=10`)).statusCode, 400);
  assert.equal((await get(`/v1/network/history/eip155:1/${address}`)).statusCode, 400);
  assert.equal((await get(`/v1/network/transfers/${chain}/${address}`)).statusCode, 400, "transfers are EVM only");
  const evmWallet = `0x${"A".repeat(40)}`;
  const transfers = await get(`/v1/network/transfers/eip155:1/${evmWallet}?limit=5`);
  assert.equal(transfers.statusCode, 200, transfers.body);
  assert.deepEqual(transfers.json().data.transfers, []);
  assert.equal(transfers.json().data.wallet, `eip155:1:${evmWallet.toLowerCase()}`);
  assert.equal((await get(`/v1/network/transfers/eip155:1/${evmWallet}?beforeHeight=1&beforePosition=0`)).statusCode, 400,
    "a transfer cursor needs its ordinal");
  assert.equal((await get(`/v1/network/transfers/eip155:1/${evmWallet}?beforeHeight=1&beforePosition=0&beforeOrdinal=-1`)).statusCode, 200);
  const report = await get(`/v1/network/reputation/${chain}/${address}`);
  assert.equal(report.json().data.status, "VALIDATED_EVIDENCE", report.body);
  assert.equal(report.json().data.score, null);
  await reputation.revoke(claim.id, "Test revocation");
  assert.equal((await get(`/v1/network/reputation/${chain}/${address}`)).json().data.status, "INSUFFICIENT_EVIDENCE");
  assert.equal((await get("/v1/me/aex")).json().balanceAtomic, "25");
  assert.equal((await get("/v1/me/aex", otherSession)).json().balanceAtomic, "0");
  assert.equal((await get("/v1/me/aex", otherSession)).json().events.length, 0);
  const developer = await get(`/v1/developer/network/history/${chain}/${address}`, devKey.key);
  assert.equal(developer.statusCode, 200, developer.body);
  assert.equal((await get("/v1/developer/network/status", session)).statusCode, 401);
  const [usage] = await sql`select count(*)::int as count from developer_usage_events where user_id = ${userId} and operation = 'network.history'`;
  assert.equal(usage?.count, 1);
  console.log(JSON.stringify({ status: "passed", migrations: migrations.length, checks: ["full API authentication", "wallet pagination", "invalid cursor", "chain isolation", "evm transfers route", "signed evidence import", "revocation", "ledger payout", "account isolation", "developer scope and metering"] }));
} finally {
  await app?.close();
  await sql.end();
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
