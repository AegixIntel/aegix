import type {
  NormalizedProgramInteraction,
  NormalizedTransaction,
  NormalizedTransfer,
  ProtocolCategory,
  TransactionClass
} from "@aegix/types";
import { parseSplTransfer, parseSystemTransfer } from "./programs/system.js";
import { parserFor, programLabelFor, protocolCategoryFor } from "./programs/registry.js";
import { PARSER_VERSION, type NormalizeInput, type NormalizerResult, type ParsedInstruction, type ParsedTransactionLike } from "./types.js";

const SOL_DECIMALS = 9;
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Detects the transaction class from its instructions.
 * Heuristic: swap programs => SWAP, NFT programs => NFT_*, etc.
 */
export function detectTransactionClass(ixs: ParsedInstruction[]): TransactionClass {
  const programIds = new Set(ixs.map((ix) => ix.programId));
  if (programIds.has("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")) return "SWAP";
  if (programIds.has("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6")) return "SWAP";
  if (programIds.has("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK")) return "SWAP";
  if (programIds.has("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")) return "PAYMENT";
  if (programIds.has("KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw")) return "LENDING";
  if (programIds.has("dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF")) return "LENDING";
  if (programIds.has("Stake11111111111111111111111111111111111111")) return "STAKE";
  const types = new Set(ixs.map((ix) => ix.parsed?.type));
  if (types.has("mintTo")) return "NFT_MINT";
  if (types.has("transfer") && programIds.has("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) return "TRANSFER";
  return "UNKNOWN";
}

/** Builds a map of account index -> mint from pre/post token balances. */
function buildTokenBalanceMints(tx: ParsedTransactionLike): Map<number, string> {
  const mints = new Map<number, string>();
  for (const bal of tx.meta?.preTokenBalances ?? []) {
    if (!mints.has(bal.accountIndex)) mints.set(bal.accountIndex, bal.mint);
  }
  for (const bal of tx.meta?.postTokenBalances ?? []) {
    if (!mints.has(bal.accountIndex)) mints.set(bal.accountIndex, bal.mint);
  }
  return mints;
}

function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Normalizes a parsed Solana transaction into AEGIX structures.
 * See architecture.md §14-§16 and the pipeline in §140.
 */
export function normalizeTransaction(input: NormalizeInput): NormalizerResult {
  const { signature, raw, walletAddress, rawProvider } = input;
  const accountKeys = raw.transaction?.message?.accountKeys ?? [];
  const instructions = raw.transaction?.message?.instructions ?? [];
  const blockTime = raw.blockTime ? new Date(raw.blockTime * 1000).toISOString() : new Date(0).toISOString();
  const tokenMints = buildTokenBalanceMints(raw);

  const transfers: NormalizedTransfer[] = [];
  const interactions: NormalizedProgramInteraction[] = [];

  for (const ix of instructions) {
    const system = parseSystemTransfer(ix);
    if (system) {
      transfers.push({
        chain: "solana",
        transactionId: signature,
        timestamp: blockTime,
        fromAddress: system.from,
        toAddress: system.to,
        assetType: "SOL",
        mint: null,
        amountRaw: String(system.lamports),
        amountNormalized: lamportsToSol(system.lamports),
        transferType: "TRANSFER"
      });
    }

    const spl = parseSplTransfer(ix);
    if (spl) {
      const mint = spl.mint ?? resolveMintFromAccounts(ix, tokenMints);
      transfers.push({
        chain: "solana",
        transactionId: signature,
        timestamp: blockTime,
        fromAddress: spl.from,
        toAddress: spl.to,
        assetType: "SPL",
        mint,
        amountRaw: spl.amount,
        amountNormalized: 0, // requires decimals; enriched by the parser
        transferType: spl.type
      });
    }

    const programParser = parserFor(ix.programId);
    const actionType = programParser?.parse(ix)?.actionType ?? ix.parsed?.type ?? "UNKNOWN";
    if (!isSystemProgram(ix.programId) || actionType !== "UNKNOWN") {
      interactions.push({
        chain: "solana",
        transactionId: signature,
        walletId: walletAddress,
        programId: ix.programId,
        programLabel: programLabelFor(ix.programId),
        protocolCategory: protocolCategoryFor(ix.programId),
        actionType,
        blockTime
      });
    }
  }

  const transactionClass = detectTransactionClass(instructions);

  const transaction: NormalizedTransaction = {
    chain: "solana",
    signature,
    slot: raw.slot,
    blockTime,
    walletId: walletAddress,
    success: raw.meta?.err == null,
    fee: (raw.meta?.fee ?? 0) / LAMPORTS_PER_SOL,
    transactionClass,
    transfers,
    programInteractions: interactions,
    rawProvider,
    parserVersion: PARSER_VERSION,
    createdAt: new Date().toISOString()
  };

  return { transaction, transfers, interactions };
}

function resolveMintFromAccounts(ix: ParsedInstruction, tokenMints: Map<number, string>): string | null {
  // Use the first known account index that has a mint mapping
  for (let i = 0; i < (ix.accounts?.length ?? 0); i++) {
    const mint = tokenMints.get(i);
    if (mint) return mint;
  }
  return null;
}

function isSystemProgram(id: string): boolean {
  return id === "11111111111111111111111111111111";
}

export type { NormalizedProgramInteraction, NormalizedTransaction, NormalizedTransfer, ProtocolCategory, TransactionClass };
