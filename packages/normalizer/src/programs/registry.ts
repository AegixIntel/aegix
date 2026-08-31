import type { ProtocolCategory } from "@aegix/types";
import type { ParsedInstruction, ProgramParser } from "../types.js";

export interface ProtocolParserDefinition {
  programId: string;
  label: string;
  category: ProtocolCategory;
  /** Known action keywords to map parsed types / program names to actions. */
  actions: Record<string, string>;
  /** Action used when the program is recognized but the instruction is not. */
  fallbackAction?: string;
}

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6";
const RAYDIUM_AMM_V4 = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const RAYDIUM_CONCENTRATED = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPFUN_FEE = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const KAMINO = "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw";
const DRIFT = "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF";
const METAPLEX_TM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const ORCA_V1 = "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP";
const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VdjYdZyBf5byvVM";
const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const MARINADE = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const WORMHOLE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
const MAGIC_EDEN_V2 = "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K";

export const PROTOCOL_PARSERS: ProtocolParserDefinition[] = [
  {
    programId: JUPITER_V6,
    label: "Jupiter",
    category: "DEX",
    actions: { swap: "SWAP", routeSwap: "SWAP", sharedAccountsExactOutRoute: "SWAP", "routeSwapV2": "SWAP" }
  },
  {
    programId: RAYDIUM_AMM,
    label: "Raydium AMM",
    category: "DEX",
    actions: { swap: "SWAP", initialize: "INITIALIZE", deposit: "DEPOSIT", withdraw: "WITHDRAW" }
  },
  {
    programId: RAYDIUM_AMM_V4,
    label: "Raydium AMM v4",
    category: "DEX",
    actions: { swap: "SWAP", initialize: "INITIALIZE", deposit: "DEPOSIT", withdraw: "WITHDRAW" }
  },
  {
    programId: RAYDIUM_CONCENTRATED,
    label: "Raydium Concentrated",
    category: "DEX",
    actions: { swap: "SWAP", createPool: "CREATE_POOL", deposit: "DEPOSIT", withdraw: "WITHDRAW" }
  },
  {
    programId: PUMPFUN,
    label: "Pump.fun",
    category: "MEMECOIN",
    actions: { buy: "BUY", sell: "SELL", create: "CREATE_TOKEN", trade: "TRADE" }
  },
  {
    programId: PUMPFUN_FEE,
    label: "Pump.fun Fees",
    category: "MEMECOIN",
    actions: { buy: "BUY", sell: "SELL", create: "CREATE_TOKEN" }
  },
  {
    programId: KAMINO,
    label: "Kamino",
    category: "LENDING",
    actions: { deposit: "DEPOSIT", withdraw: "WITHDRAW", borrow: "BORROW", repay: "REPAY", liquidate: "LIQUIDATE" }
  },
  {
    programId: DRIFT,
    label: "Drift",
    category: "LENDING",
    actions: { deposit: "DEPOSIT", withdraw: "WITHDRAW", borrow: "BORROW", repay: "REPAY", placeOrder: "PLACE_ORDER", liquidate: "LIQUIDATE" }
  },
  {
    programId: METAPLEX_TM,
    label: "Metaplex",
    category: "NFT",
    fallbackAction: "METADATA_INTERACTION",
    actions: {
      createMetadataAccount: "CREATE_METADATA",
      createMetadataAccountV3: "CREATE_METADATA",
      updateMetadataAccount: "UPDATE_METADATA",
      updateMetadataAccountV2: "UPDATE_METADATA",
      mintNewEditionFromMasterEditionViaToken: "MINT_EDITION",
      transfer: "TRANSFER"
    }
  },
  {
    programId: ORCA_V1,
    label: "Orca",
    category: "DEX",
    actions: { swap: "SWAP", initializePool: "INITIALIZE", deposit: "DEPOSIT", withdraw: "WITHDRAW" }
  },
  {
    programId: ORCA_WHIRLPOOL,
    label: "Orca Whirlpools",
    category: "DEX",
    actions: { swap: "SWAP", initializePool: "INITIALIZE", openPosition: "OPEN_POSITION", closePosition: "CLOSE_POSITION", increaseLiquidity: "ADD_LIQUIDITY", decreaseLiquidity: "REMOVE_LIQUIDITY" }
  },
  {
    programId: METEORA_DLMM,
    label: "Meteora DLMM",
    category: "DEX",
    actions: { swap: "SWAP", addLiquidity: "ADD_LIQUIDITY", removeLiquidity: "REMOVE_LIQUIDITY", createPool: "CREATE_POOL" }
  },
  {
    programId: MARINADE,
    label: "Marinade",
    category: "STAKING",
    actions: { deposit: "DEPOSIT", withdraw: "WITHDRAW", liquidUnstake: "UNSTAKE", delegateStake: "DELEGATE", orderUnstake: "UNSTAKE" }
  },
  {
    programId: WORMHOLE,
    label: "Wormhole",
    category: "BRIDGE",
    actions: { postMessage: "BRIDGE_OUT", postVaa: "BRIDGE_IN", transfer: "TRANSFER", transferNative: "BRIDGE_OUT" }
  },
  {
    programId: MAGIC_EDEN_V2,
    label: "Magic Eden v2",
    category: "NFT",
    fallbackAction: "MARKETPLACE_INTERACTION",
    actions: { buy: "BUY", sell: "SELL", list: "LIST", delist: "DELIST", executeSale: "SELL" }
  }
];

const byId = new Map(PROTOCOL_PARSERS.map((p) => [p.programId, p]));

export function parserFor(programId: string): ProgramParser | null {
  const def = byId.get(programId);
  if (!def) return null;
  return {
    programId: def.programId,
    label: def.label,
    category: def.category,
    parse(ix: ParsedInstruction) {
      const type = ix.parsed?.type;
      const action = type ? def.actions[type] : undefined;
      // Recognized program, unknown instruction: fall back to a generic
      // protocol action so the interaction is still semantically classified
      // (D3-B §18-21). Programs without an explicit fallback return null so
      // unrecognized instructions are honestly counted as PARTIALLY_PARSED.
      if (action) return { actionType: action };
      if (def.fallbackAction) return { actionType: def.fallbackAction };
      return null;
    }
  };
}

export function protocolCategoryFor(programId: string): ProtocolCategory {
  return byId.get(programId)?.category ?? "UNKNOWN";
}

export function programLabelFor(programId: string): string | null {
  return byId.get(programId)?.label ?? null;
}
