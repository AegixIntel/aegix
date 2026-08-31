/**
 * Golden ACCOUNT CLASSIFICATION test runner — D5 Block 2 fixture split (§85).
 *
 * The D3 account classifier must REJECT program IDs, mints, sysvars and
 * token accounts as user-wallet analyses. This runner verifies the
 * classifier behavior on those addresses with synthetic account-info
 * fixtures — no network required (fixtures cover classifier behavior).
 *
 * Usage: pnpm test:account-classification
 */

import { classifyAccount, isAnalysisEligible } from "@aegix/blockchain";
import type { AccountInfo } from "@aegix/blockchain";

interface ClassificationCase {
  category: string;
  address: string;
  note: string;
  info: AccountInfo | null;
  /** Whether the classifier must reject this address for user-wallet analysis. */
  expectRejected: boolean;
}

const SYSTEM = "11111111111111111111111111111111";
const BPF = "BPFLoader21111111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function prog(owner = BPF): AccountInfo {
  return { owner, executable: true, lamports: 100_000_000, dataLength: 40, data: "0x" };
}
function sysOwned(dataLength: number): AccountInfo {
  return { owner: SYSTEM, executable: false, lamports: 1_000_000, dataLength, data: "0x" };
}
function token(dataLength: number): AccountInfo {
  return { owner: TOKEN, executable: false, lamports: 1_000_000, dataLength, data: "0x" };
}

/**
 * Non-user accounts (program IDs, mints, sysvars) — the classifier must
 * reject them (they were previously in golden-wallets and failed because
 * the classifier correctly refused to analyze them).
 */
const ACCOUNT_CLASSIFICATION_CASES: ClassificationCase[] = [
  { category: "TOKEN_MINT", address: "So11111111111111111111111111111111111111112", note: "Wrapped SOL mint", info: token(82), expectRejected: true },
  { category: "SYSTEM_ACCOUNT", address: "SysvarC1ock11111111111111111111111111111111", note: "clock sysvar", info: null, expectRejected: true },
  { category: "PROTOCOL_ACCOUNT", address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", note: "Jupiter v6 program id", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6", note: "Raydium AMM program", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", note: "Raydium CLMM program", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", note: "Orca v1 program", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", note: "Meteora DLMM program", info: prog(), expectRejected: true },
  { category: "DEFI_PROGRAM", address: "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw", note: "Kamino lending program", info: prog(), expectRejected: true },
  { category: "DEFI_PROGRAM", address: "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF", note: "Drift program", info: prog(), expectRejected: true },
  { category: "NFT_PROGRAM", address: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", note: "Metaplex program", info: prog(), expectRejected: true },
  { category: "STAKING_PROGRAM", address: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", note: "Marinade program", info: prog(), expectRejected: true },
  { category: "BRIDGE_PROGRAM", address: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", note: "Wormhole bridge program", info: prog(), expectRejected: true },
  { category: "LAUNCHPAD_PROGRAM", address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", note: "Pump.fun program", info: prog(), expectRejected: true },
  { category: "USER_WALLET", address: "H4CpqxDhB2WLq43snohnKRwBEGm7XENdz8PU1cUfQm2a", note: "fresh keypair (system-owned, empty)", info: sysOwned(0), expectRejected: false }
];

let pass = 0;
let fail = 0;

for (const c of ACCOUNT_CLASSIFICATION_CASES) {
  const result = classifyAccount(c.address, c.info);
  const rejected = !isAnalysisEligible(result.accountType);
  const okFlag = rejected === c.expectRejected;
  if (okFlag) pass += 1;
  else fail += 1;
  console.log(`${okFlag ? "✔" : "✖"} ${c.category} (${c.note}): type=${result.accountType} eligible=${!rejected}${okFlag ? "" : " — MISMATCH"}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
