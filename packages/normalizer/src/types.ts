import type {
  NormalizedProgramInteraction,
  NormalizedTransaction,
  NormalizedTransfer,
  ProtocolCategory,
  TransactionClass
} from "@aegix/types";

export const PARSER_VERSION = "normalizer-v1.0.0";

/**
 * A parsed instruction from a Solana transaction (getParsedTransaction shape).
 */
export interface ParsedInstruction {
  programId: string;
  program: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
  accounts?: string[];
  data?: string;
}

export interface ParsedTransactionLike {
  slot: number;
  blockTime: number | null;
  version?: "legacy" | 0 | 1;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string; decimals?: number } }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string; decimals?: number } }>;
  };
  transaction?: {
    message?: {
      accountKeys?: Array<{ pubkey: string; signer?: boolean; writable?: boolean }>;
      instructions?: ParsedInstruction[];
      addressTableLookups?: Array<{ accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }>;
    };
  };
}

/** Parse outcome with failure tracking, see architecture.md §137. */
export interface ParseOutcome {
  result: NormalizerResult | null;
  failed: boolean;
  failureReason: string | null;
  unknownProgramCount: number;
}

export interface ProgramParser {
  readonly programId: string;
  readonly label: string;
  readonly category: ProtocolCategory;
  parse(ix: ParsedInstruction): { actionType: string } | null;
}

export interface NormalizerResult {
  transaction: NormalizedTransaction;
  transfers: NormalizedTransfer[];
  interactions: NormalizedProgramInteraction[];
}

export interface NormalizeInput {
  signature: string;
  raw: ParsedTransactionLike;
  walletAddress: string;
  rawProvider: string;
}
