import type { Address, Chain, Timestamp } from "./common.js";

/** Parsed transfer between two addresses, see architecture.md §15. */
export interface NormalizedTransfer {
  chain: Chain;
  transactionId: string;
  timestamp: Timestamp;
  fromAddress: Address;
  toAddress: Address;
  assetType: AssetType;
  mint: string | null;
  amountRaw: string;
  amountNormalized: number;
  transferType: TransferType;
}

export type AssetType = "SOL" | "SPL" | "NFT";

export type TransferType =
  | "TRANSFER"
  | "SWAP"
  | "MINT"
  | "BURN"
  | "STAKE"
  | "UNSTAKE"
  | "FEE"
  | "UNKNOWN";

/** Program interaction, see architecture.md §16. */
export interface NormalizedProgramInteraction {
  chain: Chain;
  transactionId: string;
  walletId: string;
  programId: string;
  programLabel: string | null;
  protocolCategory: ProtocolCategory;
  actionType: string;
  blockTime: Timestamp;
}

export type ProtocolCategory =
  | "DEX"
  | "LENDING"
  | "BRIDGE"
  | "NFT"
  | "STAKING"
  | "MEMECOIN"
  | "PAYMENT"
  | "EXCHANGE"
  | "SYSTEM"
  | "UNKNOWN";

/** Normalized single transaction, see architecture.md §14. */
export interface NormalizedTransaction {
  chain: Chain;
  signature: string;
  slot: number;
  blockTime: Timestamp;
  walletId: string;
  success: boolean;
  fee: number;
  transactionClass: TransactionClass;
  transfers: NormalizedTransfer[];
  programInteractions: NormalizedProgramInteraction[];
  rawProvider: string;
  parserVersion: string;
  createdAt: Timestamp;
}

export type TransactionClass =
  | "TRANSFER"
  | "SWAP"
  | "NFT_MINT"
  | "NFT_TRADE"
  | "STAKE"
  | "LENDING"
  | "BRIDGE"
  | "PAYMENT"
  | "SYSTEM"
  | "UNKNOWN";
