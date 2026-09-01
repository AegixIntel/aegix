/**
 * Developer API key material, see docs/d6-block1.md (D6-C).
 *
 * Key format: `aegix_live_<base58(16 random bytes)>` — the random portion is
 * 128 bits from node:crypto randomBytes (cryptographically secure; never
 * Math.random/timestamps). The key has ~128 bits of entropy, so brute force
 * is impractical (D6-C §40, §99).
 *
 * Hashing: the plaintext key is high-entropy by construction, so a fast
 * cryptographic hash (SHA-256) is the correct choice — no password KDF is
 * needed, and no pepper is required because the key cannot be guessed
 * (D6-C §41). The database stores only the hex digest.
 *
 * Lookup: the key prefix (12 chars, includes a per-key random 6 chars) is
 * unique among ACTIVE keys and indexed, so authentication resolves the row
 * by prefix first, then verifies the full-key hash (D6-C §55, §103-§104).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { API_KEY_PREFIX, API_KEY_PREFIX_LENGTH } from "@aegix/database";

const RANDOM_BYTES = 16; // 128 bits
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface GeneratedApiKey {
  /** Full plaintext key — shown to the user exactly once. */
  key: string;
  /** 12-char lookup prefix (static prefix + 6 random chars). */
  keyPrefix: string;
  /** SHA-256 hex digest of the full key — the only thing persisted. */
  keyHash: string;
}

/** base58-encodes a byte buffer (no leading-zero loss: buffer is random). */
function base58Encode(bytes: Uint8Array): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return digits.reverse().map((d) => BASE58_ALPHABET[d]!).join("");
}

export function generateApiKey(): GeneratedApiKey {
  const random = randomBytes(RANDOM_BYTES);
  const randomPart = base58Encode(random);
  const key = `${API_KEY_PREFIX}${randomPart}`;
  return {
    key,
    keyPrefix: key.slice(0, API_KEY_PREFIX_LENGTH),
    keyHash: hashApiKey(key)
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Constant-time verification of the full key against the stored hash. */
export function verifyApiKey(key: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(key), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** Rotates a key: generates a new key and returns it with the old key's hash
 * so callers can revoke the old key in the same transaction (D6-C §48). */
export function rotateApiKey(oldKeyHash: string): { generated: GeneratedApiKey; oldKeyHash: string } {
  return { generated: generateApiKey(), oldKeyHash };
}
