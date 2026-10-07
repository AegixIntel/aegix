import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import base58 from "bs58";
import { createDb, createObservationRepo } from "@aegix/database";
import { loadConfig } from "@aegix/config";
import { AIError, COPILOT_ENGINE_VERSION, COPILOT_SYSTEM_PROMPT, type AIProvider, type GenerateRequest } from "@aegix/ai";
import { buildServer } from "../apps/api/src/server.js";
import { requireSafeTestDatabaseReset } from "./helpers/test-environment.js";

/**
 * D16 against a real PostgreSQL: the copilot reads the stored record, gives
 * the model only that, and returns only what the model can cite from it.
 *
 * The model is a fixture. What is under test is everything around it: the
 * gates, what reaches the model, and what is removed from what it returns.
 */

const HOUR = 3_600_000;
const FLAGS = { ENABLE_AI_COPILOT: "true", ENABLE_SIGNAL_ENGINE: "true", ENABLE_NARRATIVE_RADAR: "true", ENABLE_CROSS_MARKET: "true", ENABLE_DISCOVERY: "true" };

async function main() {
  const safe = requireSafeTestDatabaseReset();
  const sql = createDb(safe.databaseUrl);
  const run = randomUUID();
  const config = loadConfig({ ...process.env, ...FLAGS });
  const observations = createObservationRepo(sql);

  const seen: GenerateRequest[] = [];
  let outage = false;
  const signalType = `E2E_${run.slice(0, 8)}`;
  const cited = `sig:market:SOL:${signalType}`;
  const model: AIProvider = {
    name: "e2e-d16",
    isConfigured: () => true,
    async generateStructuredResponse(request) {
      seen.push(request);
      if (outage) throw new AIError("TIMEOUT", "fixture outage");
      return { model: "fixture-model", latencyMs: 1, usage: { promptTokens: null, completionTokens: null }, answer: { summary: "ignored", limitations: [], findings: [
        { statement: "A SOL signal is on record.", evidenceIds: [cited] },
        { statement: "A signal nobody stored.", evidenceIds: ["sig:market:DOGE:INVENTED"] },
        { statement: "This will rise tomorrow.", evidenceIds: [cited] }
      ] } };
    }
  };
  const unconfigured: AIProvider = { name: "none", isConfigured: () => false, async generateStructuredResponse() { throw new AIError("MISSING_CREDENTIAL", "none"); } };

  const app = await buildServer({ config, aiProvider: model });
  const disabled = await buildServer({ config: loadConfig({ ...process.env, ...FLAGS, ENABLE_AI_COPILOT: "false" }), aiProvider: model });
  const noModel = await buildServer({ config, aiProvider: unconfigured });
  const narrow = await buildServer({ config: loadConfig({ ...process.env, ENABLE_AI_COPILOT: "true", ENABLE_DISCOVERY: "false" }), aiProvider: model });
  const key = ed25519.utils.randomPrivateKey();
  const address = base58.encode(ed25519.getPublicKey(key));
  let userId: string | undefined;
  try {
    const challenge = await app.inject({ method: "POST", url: "/v1/auth/wallet/challenge", payload: { wallet: address } });
    const data = challenge.json().data;
    const verification = await app.inject({ method: "POST", url: "/v1/auth/wallet/verify", payload: {
      wallet: address, challengeId: data.challengeId, nonce: data.nonce,
      signature: base58.encode(ed25519.sign(new TextEncoder().encode(data.message), key)) } });
    assert.equal(verification.statusCode, 200);
    const auth = verification.json().data;
    userId = auth.user.id;
    const headers = { authorization: `Bearer ${auth.token}` };
    const ask = (payload: Record<string, unknown>, target = app, withSession = true) =>
      target.inject({ method: "POST", url: "/v1/copilot/ask", headers: withSession ? headers : {}, payload });

    // ---- Gates: nothing reaches the model before every one has passed ----
    assert.equal((await ask({ question: "What changed?" }, disabled)).statusCode, 403);
    assert.equal((await ask({ question: "What changed?" }, app, false)).statusCode, 401);
    assert.equal((await ask({ question: "What changed?", wallet: "not-a-wallet" })).json().code, "INVALID_WALLET");
    assert.equal((await ask({ question: "x" })).statusCode, 400);
    const missing = await ask({ question: "What changed?" }, noModel);
    assert.deepEqual([missing.statusCode, missing.json().reason], [503, "MISSING_CREDENTIAL"]);
    assert.equal(seen.length, 0, "no refused request reached the model");

    // ---- The record: a stored signal is what the model is shown ----
    const source = `e2e-d16-${run}`;
    assert.equal(await observations.recordCapture({
      domain: "MARKET", subject: "SOL", bucketStart: new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString(), engineVersion: source, provider: source,
      providerStatus: "OK", qualityGrade: "HIGH",
      signals: [{ type: signalType, severity: 100, confidence: 1, title: "SOL fixture signal", summary: "A fixture signal on SOL.", evidence: [], engineVersion: source }] }), true);

    const answered = await ask({ question: "What changed in the last day?" });
    assert.equal(answered.statusCode, 200);
    const body = answered.json();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.system, COPILOT_SYSTEM_PROMPT);
    assert.ok(seen[0]!.evidenceBlock.includes(cited) && seen[0]!.evidenceBlock.includes("A fixture signal on SOL."), "the stored signal is in the evidence the model was given");
    assert.ok(seen[0]!.evidenceBlock.includes("cov:record"), "and so is what the record covers");
    assert.ok(body.evidenceOffered.includes(cited));
    assert.equal(body.evidence.find((item: { id: string }) => item.id === cited).label, "SOL fixture signal", "a cited ID can be read back as what it stands for");

    // ---- Grounding: only what cites the record, and makes no forbidden claim, comes back ----
    assert.deepEqual(body.answer.findings, [{ statement: "A SOL signal is on record.", evidenceIds: [cited] }]);
    assert.deepEqual([body.findingsDropped, body.citationsDropped], [2, 1], "the invented citation and the prediction are removed");
    assert.ok(body.answer.limitations.some((text: string) => text.includes("computes nothing")));
    assert.deepEqual(body.sources, { signals: true, narratives: true, crossMarket: true, discoveries: true, wallet: false });
    assert.deepEqual([body.engineVersion, body.model, body.wallet], [COPILOT_ENGINE_VERSION, "fixture-model", null]);
    assert.equal(body.quota.used, 1, "an answered question is metered against the Ask AEGIX limit");

    // ---- A wallet with no analysis adds nothing, and the answer says so ----
    const withWallet = (await ask({ question: "What about this wallet?", wallet: address })).json();
    assert.equal(withWallet.sources.wallet, false);
    assert.ok(withWallet.answer.limitations.some((text: string) => text.includes("no completed analysis")));

    // ---- A product that is off is not read, and the model is told ----
    const before = seen.length;
    const narrowed = (await ask({ question: "What changed?" }, narrow)).json();
    assert.deepEqual(narrowed.sources, { signals: false, narratives: false, crossMarket: false, discoveries: false, wallet: false });
    assert.deepEqual(narrowed.evidenceOffered, ["cov:record"]);
    assert.ok(seen[before]!.evidenceBlock.includes("not read (switched off)"));
    assert.deepEqual(narrowed.answer.findings, [], "with nothing to cite, nothing is stated");

    // ---- An outage costs this route and nothing else ----
    outage = true;
    const failed = await ask({ question: "What changed?" });
    assert.deepEqual([failed.statusCode, failed.json().code, failed.json().reason], [504, "AI_UNAVAILABLE", "TIMEOUT"]);
    assert.equal((await app.inject({ url: "/health/live" })).statusCode, 200);

    console.log("D16 copilot gates, evidence from the stored record, grounding and metering: PASS");
  } finally {
    await Promise.all([app.close(), disabled.close(), noModel.close(), narrow.close()]);
    if (userId) await sql`delete from profiles where id = ${userId}`;
    await sql.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "D16 E2E failure"); process.exitCode = 1; });
