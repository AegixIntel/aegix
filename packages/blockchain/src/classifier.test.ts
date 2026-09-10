import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAccount, isAnalysisEligible } from "./classifier.js";
import type { AccountInfo } from "./types.js";
import { decodeSolanaSignature } from "./solana/address.js";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

function info(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    owner: SYSTEM,
    executable: false,
    lamports: 1_000_000,
    dataLength: 0,
    data: "",
    ...overrides
  };
}

test("classifies an executable unknown program as PROGRAM", () => {
  const c = classifyAccount("SomeProgram111111111111111111111111111", info({ executable: true, owner: "BPFLoader21111111111111111111111111111111111" }));
  assert.equal(c.accountType, "PROGRAM");
  assert.ok(c.confidence >= 0.9);
  assert.equal(c.evidence.executable, true);
});

test("classifies a known protocol executable as PROTOCOL_ACCOUNT with identity", () => {
  const c = classifyAccount(JUPITER, info({ executable: true, owner: "BPFLoader21111111111111111111111111111111111" }));
  assert.equal(c.accountType, "PROTOCOL_ACCOUNT");
  assert.equal(c.protocol, "Jupiter");
  assert.equal(c.verificationStatus, "VERIFIED");
  assert.equal(c.confidence, 1);
});

test("classifies a token mint by token program ownership", () => {
  const c = classifyAccount("mint111111111111111111111111111111111111111", info({ owner: TOKEN, dataLength: 82 }));
  assert.equal(c.accountType, "TOKEN_MINT");
  assert.equal(c.evidence.owner, TOKEN);
});

test("classifies a token account by token program ownership", () => {
  const c = classifyAccount("acc1111111111111111111111111111111111111111", info({ owner: TOKEN, dataLength: 165 }));
  assert.equal(c.accountType, "TOKEN_ACCOUNT");
});

test("classifies sysvar addresses without account info", () => {
  const c = classifyAccount(SYSVAR_CLOCK, null);
  assert.equal(c.accountType, "SYSVAR");
  assert.equal(c.evidence.sysvarName, "clock");
  assert.equal(c.confidence, 1);
});

test("classifies an empty system-owned account as USER_WALLET", () => {
  const c = classifyAccount("userWallet111111111111111111111111111111", info({ owner: SYSTEM, dataLength: 0 }));
  assert.equal(c.accountType, "USER_WALLET");
  assert.ok(c.confidence >= 0.9);
});

test("classifies a system-owned account with data as PDA", () => {
  const c = classifyAccount("pda111111111111111111111111111111111111111", info({ owner: SYSTEM, dataLength: 100 }));
  assert.equal(c.accountType, "PDA");
  assert.equal(c.evidence.pdaHint, true);
});

test("non-existent account is UNKNOWN_ACCOUNT, not a wallet", () => {
  const c = classifyAccount("1111111111111111111111111111111111111111111", null);
  assert.equal(c.accountType, "UNKNOWN_ACCOUNT");
});

test("eligibility: only user wallets and unknown are analyzed", () => {
  assert.equal(isAnalysisEligible("USER_WALLET"), true);
  assert.equal(isAnalysisEligible("UNKNOWN_ACCOUNT"), true);
  assert.equal(isAnalysisEligible("PROGRAM"), false);
  assert.equal(isAnalysisEligible("PROTOCOL_ACCOUNT"), false);
  assert.equal(isAnalysisEligible("TOKEN_MINT"), false);
  assert.equal(isAnalysisEligible("TOKEN_ACCOUNT"), false);
  assert.equal(isAnalysisEligible("SYSVAR"), false);
  assert.equal(isAnalysisEligible("PDA"), false);
});

test("base58 signature decoder preserves leading zero bytes", () => {
  // 64 zero bytes encode as 64 leading base58 `1` characters.
  const decoded = decodeSolanaSignature("1".repeat(64));
  assert.equal(decoded?.length, 64);
  assert.ok(decoded?.every((byte) => byte === 0));
});

test("PumpSwap is attributed to Pump.fun, never to Raydium", () => {
  // pAMMBay… shipped labelled "Raydium AMM v4". The `pAMM` vanity prefix and
  // its co-occurrence with the Pump.fun fee program identify it as PumpSwap,
  // so every PumpSwap trade was attributed to the wrong protocol and the
  // wrong entity. This must never silently return.
  const pumpswap = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  const c = classifyAccount(pumpswap, info({ executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" }));
  assert.equal(c.accountType, "PROTOCOL_ACCOUNT");
  assert.equal(c.protocol, "Pump.fun");
  assert.notEqual(c.protocol, "Raydium");
  assert.ok(!/raydium/i.test(JSON.stringify(c)), "no Raydium attribution may survive anywhere in the classification");
});
