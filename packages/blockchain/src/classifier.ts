/**
 * Deterministic Solana account classification, see milestone D3-A §7-§12.
 *
 * Classification is evidence-based (owner, executable flag, account data
 * length, known registries) — never based on address appearance alone.
 * Runs before any expensive analysis so program/mint/sysvar addresses are
 * not fetched as if they were user wallets.
 */

import type { AccountInfo, BlockchainProvider } from "./types.js";

export type AccountType =
  | "USER_WALLET"
  | "PROGRAM"
  | "PROTOCOL_ACCOUNT"
  | "TOKEN_MINT"
  | "TOKEN_ACCOUNT"
  | "SYSVAR"
  | "PDA"
  | "UNKNOWN_ACCOUNT";

export interface ClassificationEvidence {
  executable: boolean;
  owner: string | null;
  dataLength: number;
  lamports: number;
  knownProtocol: string | null;
  sysvarName: string | null;
  pdaHint: boolean;
}

export interface AccountClassification {
  accountType: AccountType;
  confidence: number;
  evidence: ClassificationEvidence;
  /** Set when the account maps to a known protocol/entity. */
  protocol: string | null;
  /** Verification status of the known protocol, if any. */
  verificationStatus: string | null;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Well-known sysvar addresses, see architecture.md §11. */
const SYSVARS: Record<string, string> = {
  SysvarC1ock11111111111111111111111111111111: "clock",
  SysvarS1otHashes111111111111111111111111111: "slot_hashes",
  SysvarEpochSchedu1e111111111111111111111111: "epoch_schedule",
  SysvarRecentB1ockHashes1111111111111111111111: "recent_block_hashes",
  SysvarRent111111111111111111111111111111111: "rent",
  SysvarRewards111111111111111111111111111111: "rewards",
  SysvarStakeHistory1111111111111111111111111: "stake_history",
  Sysvar1nstructions1111111111111111111111111: "instructions",
  SysvarS1otHistory11111111111111111111111111: "slot_history"
};

/** Known protocol program IDs, kept in sync with the entity seed registry. */
const KNOWN_PROTOCOLS: Record<string, { protocol: string; status: string }> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: { protocol: "Jupiter", status: "VERIFIED" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6": { protocol: "Raydium AMM", status: "VERIFIED" },
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: { protocol: "Raydium AMM v4", status: "VERIFIED" },
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: { protocol: "Raydium Concentrated", status: "VERIFIED" },
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": { protocol: "Pump.fun", status: "VERIFIED" },
  KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw: { protocol: "Kamino", status: "VERIFIED" },
  dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF: { protocol: "Drift", status: "VERIFIED" },
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: { protocol: "Metaplex", status: "VERIFIED" },
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": { protocol: "Orca", status: "VERIFIED" },
  whirLbMiicVdio4qvUfM5KAg6Ct8VdjYdZyBf5byvVM: { protocol: "Orca Whirlpools", status: "VERIFIED" },
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: { protocol: "Meteora DLMM", status: "VERIFIED" },
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: { protocol: "Marinade", status: "VERIFIED" },
  worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth: { protocol: "Wormhole", status: "VERIFIED" },
  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: { protocol: "OpenBook", status: "PROBABLE" },
  M2mx93ekt1fmXSVkTrUL9xVfhkmETpw96ZJ2h3fFw1g: { protocol: "Magic Eden v2", status: "PROBABLE" },
  TSWAPaqyCsxBPKKhB9A9d3SxJS1QyJzUHVN5VKHTWA: { protocol: "Tensor", status: "PROBABLE" }
};

/**
 * Classifies an address using live account info.
 * Returns UNKNOWN_ACCOUNT when the account does not exist on-chain.
 */
export function classifyAccount(address: string, info: AccountInfo | null): AccountClassification {
  const sysvarName = SYSVARS[address] ?? null;
  if (sysvarName) {
    return {
      accountType: "SYSVAR",
      confidence: 1,
      evidence: evidenceOf(info, null, sysvarName),
      protocol: null,
      verificationStatus: null
    };
  }

  if (!info) {
    // No on-chain account: either a PDA-style derived address or simply
    // non-existent. Without evidence we must not guess.
    return {
      accountType: "UNKNOWN_ACCOUNT",
      confidence: 0.5,
      evidence: evidenceOf(null, null, null),
      protocol: null,
      verificationStatus: null
    };
  }

  const known = KNOWN_PROTOCOLS[address] ?? null;

  if (info.executable) {
    // Executable accounts are programs. Known protocol programs get their
    // protocol identity; unknown executables are generic programs.
    return {
      accountType: known ? "PROTOCOL_ACCOUNT" : "PROGRAM",
      confidence: known ? 1 : 0.95,
      evidence: evidenceOf(info, known?.protocol ?? null, null),
      protocol: known?.protocol ?? null,
      verificationStatus: known?.status ?? null
    };
  }

  // Token program ownership distinguishes mints from token accounts.
  // Token mints have data length 82 (both SPL and Token-2022); token
  // accounts hold 165 bytes and are owned by the token program.
  if (info.owner === TOKEN_PROGRAM || info.owner === TOKEN_2022_PROGRAM) {
    if (info.dataLength === 82 && info.lamports > 0) {
      return {
        accountType: "TOKEN_MINT",
        confidence: 0.9,
        evidence: evidenceOf(info, null, null),
        protocol: null,
        verificationStatus: null
      };
    }
    return {
      accountType: "TOKEN_ACCOUNT",
      confidence: 0.9,
      evidence: evidenceOf(info, null, null),
      protocol: null,
      verificationStatus: null
    };
  }

  // Associated token account program ownership.
  if (info.owner === ASSOCIATED_TOKEN_PROGRAM) {
    return {
      accountType: "TOKEN_ACCOUNT",
      confidence: 0.85,
      evidence: evidenceOf(info, null, null),
      protocol: null,
      verificationStatus: null
    };
  }

  // System-owned accounts with data are PDAs (program-derived addresses
  // hold data owned by system program). Empty system-owned accounts are
  // ordinary user wallets.
  if (info.owner === SYSTEM_PROGRAM) {
    if (info.dataLength > 0) {
      return {
        accountType: "PDA",
        confidence: 0.8,
        evidence: evidenceOf(info, null, null, true),
        protocol: null,
        verificationStatus: null
      };
    }
    return {
      accountType: "USER_WALLET",
      confidence: 0.95,
      evidence: evidenceOf(info, null, null),
      protocol: null,
      verificationStatus: null
    };
  }

  // Unknown owner, not executable, has data: likely a program-owned
  // account (PDA) but we cannot be sure.
  if (info.dataLength > 0) {
    return {
      accountType: "PDA",
      confidence: 0.6,
      evidence: evidenceOf(info, null, null, true),
      protocol: null,
      verificationStatus: null
    };
  }

  return {
    accountType: "UNKNOWN_ACCOUNT",
    confidence: 0.5,
    evidence: evidenceOf(info, null, null),
    protocol: null,
    verificationStatus: null
  };
}

/** Fetches account info and classifies in one step (with provider failover). */
export async function classifyAddress(provider: BlockchainProvider, address: string): Promise<AccountClassification> {
  const info = await provider.getAccountInfo(address);
  return classifyAccount(address, info);
}

/** Whether the account type is eligible for full wallet privacy analysis. */
export function isAnalysisEligible(type: AccountType): boolean {
  return type === "USER_WALLET" || type === "UNKNOWN_ACCOUNT";
}

function evidenceOf(
  info: AccountInfo | null,
  knownProtocol: string | null,
  sysvarName: string | null,
  pdaHint = false
): ClassificationEvidence {
  return {
    executable: info?.executable ?? false,
    owner: info?.owner ?? null,
    dataLength: info?.dataLength ?? 0,
    lamports: info?.lamports ?? 0,
    knownProtocol,
    sysvarName,
    pdaHint
  };
}

export const ACCOUNT_CLASSIFIER_VERSION = "account-classifier-v1.0.0";
