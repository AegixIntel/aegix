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
import { CANONICAL_PROGRAMS } from "@aegix/types";
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

/**
 * Resolves a fixture program address from the canonical catalog instead of
 * copying it. These fixtures used to carry their own copies, and four of them
 * silently rotted into addresses with no mainnet account — the fixture still
 * passed while describing a protocol it no longer pointed at. A stale label
 * now throws instead of quietly testing the wrong address.
 */
function catalogProgram(label: string): string {
  const program = CANONICAL_PROGRAMS.find((p) => p.label === label);
  if (!program) throw new Error(`fixture references "${label}", which is not in the canonical program catalog`);
  return program.programId;
}

const ACCOUNT_CLASSIFICATION_CASES: ClassificationCase[] = [
  { category: "TOKEN_MINT", address: "So11111111111111111111111111111111111111112", note: "Wrapped SOL mint", info: token(82), expectRejected: true },
  { category: "SYSTEM_ACCOUNT", address: "SysvarC1ock11111111111111111111111111111111", note: "clock sysvar", info: null, expectRejected: true },
  { category: "PROTOCOL_ACCOUNT", address: catalogProgram("Jupiter Aggregator v6"), note: "Jupiter v6 program id", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: catalogProgram("Raydium Liquidity Pool v4"), note: "Raydium AMM program", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: catalogProgram("Raydium Concentrated Liquidity"), note: "Raydium CLMM program", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: catalogProgram("Orca v1 Pools"), note: "Orca v1 program", info: prog(), expectRejected: true },
  { category: "DEX_PROGRAM", address: catalogProgram("Meteora DLMM"), note: "Meteora DLMM program", info: prog(), expectRejected: true },
  { category: "DEFI_PROGRAM", address: catalogProgram("Kamino Lending"), note: "Kamino lending program", info: prog(), expectRejected: true },
  { category: "DEFI_PROGRAM", address: catalogProgram("Drift v2"), note: "Drift program", info: prog(), expectRejected: true },
  { category: "NFT_PROGRAM", address: catalogProgram("Metaplex Token Metadata"), note: "Metaplex program", info: prog(), expectRejected: true },
  { category: "STAKING_PROGRAM", address: catalogProgram("Marinade Finance"), note: "Marinade program", info: prog(), expectRejected: true },
  { category: "BRIDGE_PROGRAM", address: catalogProgram("Wormhole Core Bridge"), note: "Wormhole bridge program", info: prog(), expectRejected: true },
  { category: "LAUNCHPAD_PROGRAM", address: catalogProgram("Pump.fun Bonding Curve"), note: "Pump.fun program", info: prog(), expectRejected: true },
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
