import assert from "node:assert/strict";
import { classifyAccount, isAnalysisEligible, isValidSolanaAddress } from "@aegix/blockchain";
import type { AccountInfo } from "@aegix/blockchain";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const wallets = [
  "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a",
  "EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj",
  "DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb",
  "ENxD1HAtyHq8skEMpjU3r9KtGMBVcTUeHTe4Mxks1Hov",
  "J6AvzEkmvepWB498Q4QzHvTxgaLTqKBAoL3JFXVisEWx",
  "E3ygRpueE2J1FS9G8SgrLzoenzjWrrYU5bm1o2jCuyVh",
  "6zqwqqE7CzJqaMxdLuE6VxtYVh1U4FTeUiEYVsSzgtG2",
  "BMBco364nogesPsjga6FJaQETsP39YEqTPaFkCFtLbsP"
];

const recordedSystemWallet: AccountInfo = {
  owner: SYSTEM_PROGRAM,
  executable: false,
  lamports: 1_000_000,
  dataLength: 0,
  data: ""
};

for (const address of wallets) {
  assert.equal(isValidSolanaAddress(address), true, `${address} is valid base58`);
  const classification = classifyAccount(address, recordedSystemWallet);
  assert.equal(classification.accountType, "USER_WALLET", `${address} fixture classifies as USER_WALLET`);
  assert.equal(isAnalysisEligible(classification.accountType), true, `${address} remains analysis eligible`);
}

console.log(`${wallets.length} deterministic wallet fixtures passed`);
