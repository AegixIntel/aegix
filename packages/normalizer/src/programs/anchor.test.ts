import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorDiscriminator, buildAnchorLookup, decodeInstructionData, matchAnchorAction, matchByteAction } from "./anchor.js";
import { parserFor, programLabelFor, protocolCategoryFor } from "./registry.js";

/**
 * Discriminators observed in real mainnet instruction data. Each was captured
 * from live transactions for the program named, then matched back to the
 * method name by computing sha256("global:<method>"). An 8-byte preimage
 * collision is not a practical possibility, so these pin both the method
 * names and the parser's byte handling.
 */
const OBSERVED: Array<[program: string, method: string, discriminator: string]> = [
  ["Bubblegum", "transfer", "a334c8e78c0345ba"],
  ["Bubblegum", "transfer_v2", "772806ebeaddf831"],
  ["Bubblegum", "update_metadata_v2", "2b67592a79f23e48"],
  ["Candy Machine v3 / Guard", "mint_v2", "78791792ad6ec7cd"],
  ["Candy Machine v3", "add_config_lines", "df32e0e39708736a"],
  ["Candy Machine v3", "initialize_v2", "4399af27da102620"],
  ["Candy Guard", "route", "e517cb977ae3ad2a"],
  ["Candy Guard", "wrap", "b2280abde481ba8c"],
  ["Auction House", "sell", "33e685a4017f83ad"],
  ["Auction House", "buy", "66063d1201daebea"],
  ["Auction House", "execute_sale", "254ad99d4f312306"],
  ["Auction House", "cancel", "e8dbdf29dbecdcbe"],
  ["Auction House", "print_listing_receipt", "cf6b2ca04bdec31b"],
  ["TCOMP", "bid", "c738552692f3259e"],
  ["TCOMP", "edit", "0fb72156571c9791"],
  ["TCOMP", "buy_core", "a9e357ff4c56ff19"],
  ["TCOMP", "list_core", "ad4ca77d76470199"],
  ["TCOMP", "delist_core", "3818e702e3130e44"],
  ["Tensor Escrow", "deposit_margin_account", "be55f23c775121c0"],
  ["Tensor Escrow", "withdraw_margin_account", "364996d0cf051211"],
  ["Tensor Bid", "close_expired_bid", "53146943f84468be"],
  ["Magic Eden MMM", "update_pool", "efd6aa4e24231e22"],
  ["Magic Eden MMM", "sol_deposit_buy", "42e50b366da455ee"]
];

test("computed discriminators match the ones observed on mainnet", () => {
  for (const [program, method, expected] of OBSERVED) {
    assert.equal(anchorDiscriminator(method), expected, `${program}.${method}`);
  }
});

test("discriminator depends on the namespace", () => {
  assert.notEqual(anchorDiscriminator("transfer", "global"), anchorDiscriminator("transfer", "event"));
});

test("decodeInstructionData rejects absent and malformed data", () => {
  assert.equal(decodeInstructionData(undefined), null);
  assert.equal(decodeInstructionData(""), null);
  assert.equal(decodeInstructionData("0OIl"), null, "not base58");
});

test("matchAnchorAction needs at least a full 8-byte discriminator", () => {
  const lookup = buildAnchorLookup({ transfer: "TRANSFER" });
  // "2" decodes to a single byte — too short to carry a discriminator.
  assert.equal(matchAnchorAction("2", lookup), null);
  assert.equal(matchAnchorAction(undefined, lookup), null);
});

test("matchByteAction reads the leading u8 instruction index", () => {
  const transferIx = toBase58([49, 7, 7]); // Token Metadata Transfer, index 49
  assert.equal(matchByteAction(transferIx, { 49: "TRANSFER" }), "TRANSFER");
  assert.equal(matchByteAction(transferIx, { 33: "CREATE_METADATA" }), null);
  assert.equal(matchByteAction(undefined, { 49: "TRANSFER" }), null);
});

/** Encodes bytes to base58, mirroring how the RPC returns instruction data. */
function toBase58(bytes: number[]): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  const digits: number[] = [];
  for (let i = leading; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      const x = (digits[j]! << 8) + carry;
      digits[j] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(leading) + digits.reverse().map((d) => ALPHABET[d]).join("");
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

const BUBBLEGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const TCOMP = "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp";
const TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const TENSORSWAP = "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN";

test("Bubblegum compressed-NFT transfers parse from raw instruction data", () => {
  // The RPC never fills `parsed.type` for Bubblegum, so before discriminator
  // support every compressed-NFT instruction was unrecognized.
  const parser = parserFor(BUBBLEGUM);
  assert.ok(parser, "Bubblegum is a known program");
  const data = toBase58([...hexToBytes("a334c8e78c0345ba"), 0, 0, 0, 0]);
  assert.deepEqual(parser.parse({ programId: BUBBLEGUM, program: "unknown", data }), { actionType: "TRANSFER" });
});

test("TCOMP marketplace bids parse from raw instruction data", () => {
  const parser = parserFor(TCOMP)!;
  const data = toBase58([...hexToBytes("c738552692f3259e"), 1, 2, 3]);
  assert.deepEqual(parser.parse({ programId: TCOMP, program: "unknown", data }), { actionType: "BID" });
});

test("Token Metadata transfers parse from the shank u8 index", () => {
  const parser = parserFor(TOKEN_METADATA)!;
  // Index 49 = Transfer, confirmed on mainnet by co-occurrence with
  // spl-token transferChecked in every sampled transaction.
  assert.deepEqual(parser.parse({ programId: TOKEN_METADATA, program: "unknown", data: toBase58([49, 0]) }), { actionType: "TRANSFER" });
  // Index 33 = CreateMetadataAccountV3, confirmed by co-occurrence with
  // initializeMint2 + mintTo.
  assert.deepEqual(parser.parse({ programId: TOKEN_METADATA, program: "unknown", data: toBase58([33, 0]) }), { actionType: "CREATE_METADATA" });
});

test("an unmapped instruction returns null rather than a guessed action", () => {
  // Tensor Escrow has no fallback on purpose: a generic action for an
  // instruction we did not identify would inflate semanticCoverage, which is
  // exactly the metric that caps reported confidence.
  const parser = parserFor(TENSORSWAP)!;
  const data = toBase58([...hexToBytes("ffffffffffffffff"), 9]);
  assert.equal(parser.parse({ programId: TENSORSWAP, program: "unknown", data }), null);
});

test("single-purpose programs keep a fallback because the category is the semantics", () => {
  const memo = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  assert.deepEqual(parserFor(memo)!.parse({ programId: memo, program: "memo", data: "abc" }), { actionType: "MEMO" });
});

test("natively parsed instruction types still take precedence", () => {
  const jupiter = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const parser = parserFor(jupiter)!;
  assert.deepEqual(parser.parse({ programId: jupiter, program: "jupiter", parsed: { type: "swap" } }), { actionType: "SWAP" });
});

test("corrected protocol addresses are the ones the parser recognizes", () => {
  // Each of these used to sit in the registry as an address with no mainnet
  // account, so the protocol was counted as an unknown program.
  const corrected: Array<[address: string, label: string]> = [
    ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium Liquidity Pool v4"],
    ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpools"],
    ["KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", "Kamino Lending"],
    ["dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "Drift v2"]
  ];
  for (const [address, label] of corrected) {
    assert.equal(programLabelFor(address), label);
    assert.ok(parserFor(address), `${label} must have a parser`);
  }

  for (const stale of [
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wF2tcy6u6",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VdjYdZyBf5byvVM",
    "KLend2g3cP87fffH8vSekita2WqbcjYb75QHoWJvEPw",
    "dRiftyHA39MWEi3m9aunc5tRFoFjCjFQ5uMYFnMqdfF"
  ]) {
    assert.equal(parserFor(stale), null, `${stale} matches nothing on-chain and must not be registered`);
  }
});

test("PumpSwap is no longer mislabelled as Raydium", () => {
  // pAMMBay… carries the `pAMM` vanity prefix and co-occurs with the Pump.fun
  // fee program; it was carried as "Raydium AMM v4", which mis-attributed
  // every PumpSwap trade to the wrong protocol and the wrong entity.
  const pumpswap = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  assert.equal(programLabelFor(pumpswap), "PumpSwap AMM");
  assert.equal(protocolCategoryFor(pumpswap), "MEMECOIN");
});
