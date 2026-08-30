import type { ProtocolCategory } from "@aegix/types";
import type { ParsedInstruction, ProgramParser } from "../types.js";

export interface ProtocolParserDefinition {
  programId: string;
  label: string;
  category: ProtocolCategory;
  /** Known action keywords to map parsed types / program names to actions. */
  actions: Record<string, string>;
}

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6";
const RAYDIUM_CONCENTRATED = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PUMPFUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const KAMINO = "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw";
const DRIFT = "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF";

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
      if (!action) return null;
      return { actionType: action };
    }
  };
}

export function protocolCategoryFor(programId: string): ProtocolCategory {
  return byId.get(programId)?.category ?? "UNKNOWN";
}

export function programLabelFor(programId: string): string | null {
  return byId.get(programId)?.label ?? null;
}
