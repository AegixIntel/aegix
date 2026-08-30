import type { ParsedInstruction } from "../types.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";

export interface SolTransferInfo {
  from?: string;
  to?: string;
  lamports?: number;
}

/** Parses system program transfers (native SOL). */
export function parseSystemTransfer(ix: ParsedInstruction): { from: string; to: string; lamports: number } | null {
  if (ix.programId !== SYSTEM_PROGRAM) return null;
  if (ix.parsed?.type === "transfer") {
    const info = ix.parsed.info as SolTransferInfo;
    if (info?.from && info?.to && typeof info.lamports === "number") {
      return { from: info.from, to: info.to, lamports: info.lamports };
    }
  }
  return null;
}

export interface SplTransferInfo {
  authority?: string;
  source?: string;
  destination?: string;
  amount?: string;
  tokenAmount?: { amount?: string; decimals?: number };
}

/** Parses SPL token transfers (mint, transfer, burn). */
export function parseSplTransfer(ix: ParsedInstruction): {
  type: "TRANSFER" | "MINT" | "BURN";
  from: string;
  to: string;
  amount: string;
  mint: string | null;
} | null {
  if (ix.programId !== TOKEN_PROGRAM && ix.programId !== TOKEN_2022_PROGRAM) return null;
  const type = ix.parsed?.type;
  if (type === "transfer" || type === "mintTo" || type === "burn") {
    const info = ix.parsed?.info as SplTransferInfo | undefined;
    const amount = info?.tokenAmount?.amount ?? info?.amount;
    if (!info || !amount) return null;
    return {
      type: type === "mintTo" ? "MINT" : type === "burn" ? "BURN" : "TRANSFER",
      from: info.authority ?? info.source ?? "",
      to: info.destination ?? "",
      amount,
      mint: null // resolved from pre/post token balances by the caller
    };
  }
  return null;
}

export function isSystemProgram(id: string): boolean {
  return id === SYSTEM_PROGRAM;
}

export function isTokenProgram(id: string): boolean {
  return id === TOKEN_PROGRAM || id === TOKEN_2022_PROGRAM;
}

export function isStakeProgram(id: string): boolean {
  return id === STAKE_PROGRAM || id === VOTE_PROGRAM;
}

export function isAssociatedTokenProgram(id: string): boolean {
  return id === ASSOCIATED_TOKEN_PROGRAM;
}

export const KNOWN_PROGRAM_IDS = {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  STAKE_PROGRAM,
  VOTE_PROGRAM
} as const;

export type { ParsedInstruction };
