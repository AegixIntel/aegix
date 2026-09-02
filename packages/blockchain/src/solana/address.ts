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

/**
 * Decodes a base58 Solana address to its 32-byte public key.
 * Returns null for malformed input (never throws).
 */
export function decodeSolanaPublicKey(address: string): Uint8Array | null {
  try {
    return new PublicKey(address).toBytes();
  } catch {
    return null;
  }
}

/**
 * Decodes a base58 signature to raw bytes. Returns null for malformed
 * input. Solana Ed25519 signatures are exactly 64 bytes.
 */
export function decodeSolanaSignature(signature: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(signature)) return null;
  const bytes = base58Decode(signature);
  if (!bytes || bytes.length !== 64) return null;
  return bytes;
}

/** Minimal base58 decoder (public-key style inputs, no leading-zero loss
 *  handling needed for random 32/64-byte payloads). */
function base58Decode(input: string): Uint8Array | null {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const ch of input) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    num = num * 58n + BigInt(idx);
  }
  // Convert to big-endian bytes.
  const hex = num.toString(16).padStart(1, "0");
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
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
