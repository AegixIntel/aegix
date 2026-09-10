import type { ParsedInstruction } from "../types.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";

export interface SolTransferInfo {
  /** The field names Solana's jsonParsed encoding actually emits. */
  source?: string;
  destination?: string;
  /** Accepted as aliases so hand-written fixtures keep working. */
  from?: string;
  to?: string;
  lamports?: number;
}

/**
 * Parses system program transfers (native SOL).
 *
 * `jsonParsed` names these fields `source` and `destination`. This function
 * used to accept only `from`/`to`, which no mainnet transaction carries, so
 * every native SOL transfer was silently dropped: the transfers table stayed
 * empty, the funding engine reported NO_INCOMING_FUNDING for funded wallets,
 * and counterparty/pattern analysis had nothing to measure.
 */
export function parseSystemTransfer(ix: ParsedInstruction): { from: string; to: string; lamports: number } | null {
  if (ix.programId !== SYSTEM_PROGRAM) return null;
  const type = ix.parsed?.type;
  if (type !== "transfer" && type !== "transferWithSeed") return null;
  const info = ix.parsed?.info as SolTransferInfo | undefined;
  if (!info || typeof info.lamports !== "number") return null;
  const from = info.source ?? info.from;
  const to = info.destination ?? info.to;
  if (!from || !to) return null;
  return { from, to, lamports: info.lamports };
}

export interface SplTransferInfo {
  authority?: string;
  source?: string;
  destination?: string;
  account?: string;
  mint?: string;
  amount?: string;
  tokenAmount?: { amount?: string; decimals?: number };
}

/**
 * SPL instruction types that move token balance, mapped to their direction.
 *
 * The `*Checked` variants matter: `transferChecked` is the most common SPL
 * token instruction on mainnet by a wide margin, and handling only the
 * unchecked `transfer` dropped the majority of real token movement.
 */
const SPL_TRANSFER_TYPES: Record<string, "TRANSFER" | "MINT" | "BURN"> = {
  transfer: "TRANSFER",
  transferChecked: "TRANSFER",
  mintTo: "MINT",
  mintToChecked: "MINT",
  burn: "BURN",
  burnChecked: "BURN"
};

/** Parses SPL token movement (transfer, mint, burn, and their checked forms). */
export function parseSplTransfer(ix: ParsedInstruction): {
  type: "TRANSFER" | "MINT" | "BURN";
  from: string;
  to: string;
  amount: string;
  mint: string | null;
} | null {
  if (ix.programId !== TOKEN_PROGRAM && ix.programId !== TOKEN_2022_PROGRAM) return null;
  const type = ix.parsed?.type;
  if (!type) return null;
  const direction = SPL_TRANSFER_TYPES[type];
  if (!direction) return null;

  const info = ix.parsed?.info as SplTransferInfo | undefined;
  const amount = info?.tokenAmount?.amount ?? info?.amount;
  if (!info || !amount) return null;

  // Burns name the debited token account `account`; transfers name it `source`.
  const from = info.authority ?? info.source ?? info.account ?? "";
  const to = info.destination ?? "";
  return {
    type: direction,
    from,
    to,
    // The checked forms carry the mint directly; otherwise the caller
    // resolves it from pre/post token balances.
    mint: info.mint ?? null,
    amount
  };
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
