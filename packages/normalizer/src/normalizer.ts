import type {
  NormalizedProgramInteraction,
  NormalizedTransaction,
  NormalizedTransfer,
  ProtocolCategory,
  TransactionClass
} from "@aegix/types";
import { parseSplTransfer, parseSystemTransfer } from "./programs/system.js";
import { parserFor, programLabelFor, protocolCategoryFor } from "./programs/registry.js";
import {
  PARSER_VERSION,
  type NormalizeInput,
  type NormalizerResult,
  type ParseOutcome,
  type ParsedInstruction,
  type ParsedTransactionLike
} from "./types.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

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

/**
 * Normalizes a parsed Solana transaction into AEGIX structures.
 * Handles inner instructions, wrapped SOL, missing blockTime, versioned
 * transactions and unknown programs without throwing. Parse failures are
 * reported through ParseOutcome so the pipeline can continue.
 */
export function normalizeTransaction(input: NormalizeInput): ParseOutcome {
  const { signature, raw, walletAddress, rawProvider } = input;

  try {
    const accountKeys = raw.transaction?.message?.accountKeys ?? [];
    const outerInstructions = raw.transaction?.message?.instructions ?? [];
    const innerInstructions = raw.meta && "innerInstructions" in raw.meta
      ? ((raw.meta as { innerInstructions?: Array<{ instructions?: ParsedInstruction[] }> }).innerInstructions ?? [])
      : [];
    const allInstructions = [
      ...outerInstructions,
      ...innerInstructions.flatMap((group) => group.instructions ?? [])
    ];

    const blockTime = raw.blockTime ? new Date(raw.blockTime * 1000).toISOString() : null;
    const timestamp = blockTime ?? new Date(0).toISOString();
    const accountKeyByIndex = new Map(accountKeys.map((k, i) => [i, k.pubkey]));
    const tokenBalances = buildTokenBalanceMap(raw);
    const unknownProgramCount = allInstructions.filter(
      (ix) => !isSystemProgram(ix.programId) && !isTokenProgram(ix.programId) && !parserFor(ix.programId)
    ).length;

    const transfers: NormalizedTransfer[] = [];
    const interactions: NormalizedProgramInteraction[] = [];
    const seenTransfers = new Set<string>();

    for (const ix of allInstructions) {
      const system = parseSystemTransfer(ix);
      if (system) {
        const dedupeKey = `sol:${system.from}:${system.to}:${system.lamports}`;
        if (!seenTransfers.has(dedupeKey)) {
          seenTransfers.add(dedupeKey);
          transfers.push({
            chain: "solana",
            transactionId: signature,
            timestamp,
            fromAddress: system.from,
            toAddress: system.to,
            assetType: "SOL",
            mint: null,
            amountRaw: String(system.lamports),
            amountNormalized: system.lamports / LAMPORTS_PER_SOL,
            transferType: "TRANSFER"
          });
        }
      }

      const spl = parseSplTransfer(ix);
      if (spl) {
        const mint = spl.mint ?? resolveMintFromAccounts(ix, accountKeyByIndex, tokenBalances) ?? null;
        const amount = resolveSplAmount(ix, tokenBalances, spl.amount);
        const dedupeKey = `spl:${spl.from}:${spl.to}:${mint}:${spl.amount}`;
        if (!seenTransfers.has(dedupeKey)) {
          seenTransfers.add(dedupeKey);
          transfers.push({
            chain: "solana",
            transactionId: signature,
            timestamp,
            fromAddress: spl.from,
            toAddress: spl.to,
            assetType: mint === WRAPPED_SOL_MINT ? "SOL" : "SPL",
            mint,
            amountRaw: spl.amount,
            amountNormalized: amount,
            transferType: spl.type
          });
        }
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
          blockTime: timestamp
        });
      }
    }

    const transactionClass = detectTransactionClass(allInstructions);

    // Semantic classification, see milestone D2 Phase 19-20.
    // Count instructions whose semantics we actually understand: system/SPL
    // transfers, token program actions, and known protocol actions.
    let understood = 0;
    let knownProtocolActions = 0;
    let knownProgramsPresent = false;
    for (const ix of allInstructions) {
      const parser = parserFor(ix.programId);
      if (parser) {
        knownProgramsPresent = true;
        const action = parser.parse(ix)?.actionType;
        if (action) {
          understood += 1;
          knownProtocolActions += 1;
        }
        continue;
      }
      if (isSystemProgram(ix.programId) || isTokenProgram(ix.programId) || ix.parsed?.type) {
        understood += 1;
      }
    }
    const parseClass: ParseOutcome["parseClass"] =
      knownProtocolActions > 0 ? "FULLY_PARSED" : knownProgramsPresent ? "PARTIALLY_PARSED" : "GENERIC_PARSED";
    const semanticCoverage = allInstructions.length > 0 ? understood / allInstructions.length : 0;

    const transaction: NormalizedTransaction = {
      chain: "solana",
      signature,
      slot: raw.slot,
      blockTime: timestamp,
      walletId: walletAddress,
      success: raw.meta?.err == null,
      fee: raw.meta?.fee ?? 0, // lamports, integer — matches transactions.fee bigint
      transactionClass,
      transfers,
      programInteractions: interactions,
      rawProvider,
      parserVersion: PARSER_VERSION,
      createdAt: new Date().toISOString()
    };

    return {
      result: { transaction, transfers, interactions },
      failed: false,
      failureReason: null,
      unknownProgramCount,
      parseClass,
      semanticCoverage
    };
  } catch (err) {
    return {
      result: null,
      failed: true,
      failureReason: err instanceof Error ? err.message : String(err),
      unknownProgramCount: 0,
      parseClass: "FAILED",
      semanticCoverage: 0
    };
  }
}

function buildTokenBalanceMap(raw: ParsedTransactionLike): Map<number, { mint: string; amount: string; decimals: number }> {
  const map = new Map<number, { mint: string; amount: string; decimals: number }>();
  const pre = raw.meta?.preTokenBalances ?? [];
  const post = raw.meta?.postTokenBalances ?? [];
  // prefer post balances for the "after" state
  for (const bal of post) {
    map.set(bal.accountIndex, { mint: bal.mint, amount: bal.uiTokenAmount.amount, decimals: bal.uiTokenAmount.decimals ?? 0 });
  }
  for (const bal of pre) {
    if (!map.has(bal.accountIndex)) {
      map.set(bal.accountIndex, { mint: bal.mint, amount: bal.uiTokenAmount.amount, decimals: bal.uiTokenAmount.decimals ?? 0 });
    }
  }
  return map;
}

function resolveMintFromAccounts(
  ix: ParsedInstruction,
  accountKeyByIndex: Map<number, string>,
  tokenBalances: Map<number, { mint: string; amount: string; decimals: number }>
): string | null {
  // token balance mints are the most reliable
  for (let i = 0; i < (ix.accounts?.length ?? 0); i++) {
    const bal = tokenBalances.get(i);
    if (bal) return bal.mint;
  }
  // fall back to token program account heuristic: account[0] often the token account;
  // without an index->mint map we cannot infer reliably, so return null
  return null;
}

function resolveSplAmount(
  ix: ParsedInstruction,
  tokenBalances: Map<number, { mint: string; amount: string; decimals: number }>,
  fallback: string
): number {
  // use the first token balance diff for this instruction's accounts if available
  for (let i = 0; i < (ix.accounts?.length ?? 0); i++) {
    const bal = tokenBalances.get(i);
    if (bal && bal.decimals > 0) {
      return Number(bal.amount) / 10 ** bal.decimals;
    }
  }
  // fallback: parse raw amount as base units of 9 decimals (approximation)
  const n = Number(fallback);
  return Number.isFinite(n) ? n / 1e9 : 0;
}

function isSystemProgram(id: string): boolean {
  return id === SYSTEM_PROGRAM_ID;
}

function isTokenProgram(id: string): boolean {
  return id === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || id === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
}

export type { NormalizedProgramInteraction, NormalizedTransaction, NormalizedTransfer, ProtocolCategory, TransactionClass };
