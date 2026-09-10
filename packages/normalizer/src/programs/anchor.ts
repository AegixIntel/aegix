/**
 * Instruction-data parsing for programs the RPC cannot parse for us.
 *
 * `getParsedTransaction` only fills `instruction.parsed.type` for programs
 * the validator knows natively — System, SPL Token, Stake, and a handful of
 * others. Every Metaplex, Tensor and Magic Eden program returns raw base58
 * `data` instead, so an action map keyed on `parsed.type` can never match
 * them. That is why NFT activity was landing as PARTIALLY_PARSED: the
 * program was recognized, but not a single instruction was.
 *
 * Two discriminator conventions cover those programs:
 *
 *   Anchor  — the first 8 bytes are sha256("<namespace>:<method>")[0..8],
 *             with namespace "global" for ordinary instructions. The mapping
 *             is one-way, so we precompute the digest for each method name we
 *             claim to support and match on the bytes.
 *
 *   Shank   — Metaplex Token Metadata and Core prefix instructions with a
 *             single u8 index into the instruction enum.
 *
 * Every Anchor method name in the registry was confirmed against mainnet:
 * its computed discriminator was observed in real instruction data for that
 * program. An 8-byte digest collision is not a practical possibility, so an
 * observed match confirms both the name and the mapping. Instructions whose
 * discriminator we could not attribute are deliberately left unmapped — they
 * fall through to the program's fallback action and are reported honestly
 * rather than guessed.
 */

import { createHash } from "node:crypto";
import { base58Decode } from "@aegix/types";

/** Anchor discriminator: first 8 bytes of sha256("<namespace>:<method>"). */
export function anchorDiscriminator(method: string, namespace = "global"): string {
  return createHash("sha256").update(`${namespace}:${method}`).digest().subarray(0, 8).toString("hex");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Builds a discriminator → action lookup from a method → action map.
 * Keys are hex digests so matching is a plain string compare.
 */
export function buildAnchorLookup(methodActions: Record<string, string>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [method, action] of Object.entries(methodActions)) {
    lookup.set(anchorDiscriminator(method), action);
  }
  return lookup;
}

/** Decoded instruction data, or null when absent/undecodable. */
export function decodeInstructionData(data: string | undefined): Uint8Array | null {
  if (!data) return null;
  return base58Decode(data);
}

/** Anchor: match the leading 8 bytes of instruction data. */
export function matchAnchorAction(data: string | undefined, lookup: Map<string, string>): string | null {
  const bytes = decodeInstructionData(data);
  if (!bytes || bytes.length < 8) return null;
  return lookup.get(toHex(bytes.subarray(0, 8))) ?? null;
}

/** Shank: match the single leading u8 instruction index. */
export function matchByteAction(data: string | undefined, byteActions: Record<number, string>): string | null {
  const bytes = decodeInstructionData(data);
  if (!bytes || bytes.length < 1) return null;
  return byteActions[bytes[0]!] ?? null;
}
