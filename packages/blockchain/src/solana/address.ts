import { PublicKey } from "@solana/web3.js";
import type { SignatureInfo, TokenAccountInfo } from "../types.js";

/** Solana address validation via base58 public key parsing. */
export function isValidSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function formatSignatureInfo(sig: {
  signature: string;
  slot: number;
  blockTime?: number | null;
}): SignatureInfo {
  return {
    signature: sig.signature,
    slot: sig.slot,
    blockTime: sig.blockTime ?? null
  };
}

export function formatTokenAccount(raw: {
  pubkey?: string;
  account?: {
    data?: {
      parsed?: {
        info?: {
          mint?: string;
          tokenAmount?: { amount?: string; decimals?: number };
          owner?: string;
        };
      };
    };
  };
}): TokenAccountInfo | null {
  const info = raw.account?.data?.parsed?.info;
  if (!info?.mint || !info.tokenAmount) return null;
  return {
    mint: info.mint,
    amount: info.tokenAmount.amount ?? "0",
    decimals: info.tokenAmount.decimals ?? 0,
    owner: info.owner ?? ""
  };
}
