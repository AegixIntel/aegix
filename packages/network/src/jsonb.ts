import type postgres from "postgres";

const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";

/**
 * A copy of an RPC payload that jsonb can actually store.
 *
 * PostgreSQL cannot represent U+0000 in `jsonb` — an escape sequence in the
 * JSON text is decoded to a NUL code point, which no text type can hold, and
 * the insert is rejected with `unsupported Unicode escape sequence`. Solana's
 * `jsonParsed` envelopes do carry them: slot 425503014 on mainnet has seven,
 * inside vote-account seed fields. Without this, one such block fails its
 * insert, the cursor never advances, and the daemon retries that block forever.
 *
 * A NUL code point is recorded as U+FFFD (length preserved) rather than
 * dropped, so the parsed copy says a character was unrepresentable. The exact
 * envelope is unaffected: `network_blocks.raw_rpc` keeps the RPC's own text.
 */
export function jsonbSafe(value: unknown): postgres.JSONValue {
  if (typeof value === "string") return value.includes(NUL) ? value.split(NUL).join(REPLACEMENT) : value;
  if (Array.isArray(value)) return value.map(jsonbSafe);
  if (value && typeof value === "object") {
    const copy: Record<string, postgres.JSONValue> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = jsonbSafe(item);
    return copy;
  }
  return value as postgres.JSONValue;
}
