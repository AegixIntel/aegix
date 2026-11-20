import test from "node:test";
import assert from "node:assert/strict";
import { TRANSFER_TOPIC, type EvmReceipt } from "./evm-receipts.js";
import { decodeTransferLog, transfersOf, ZERO_ADDRESS } from "./evm-transfers.js";
import { projectBlock } from "./projection.js";

const a = `0x${"a".repeat(40)}`;
const b = `0x${"b".repeat(40)}`;
const token = `0x${"c".repeat(40)}`;
const pad = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const receipt = (status: 0 | 1, transferLogs: EvmReceipt["transferLogs"] = []): EvmReceipt =>
  ({ transactionHash: `0x${"1".repeat(64)}`, transactionIndex: 0, status, from: a, gasUsed: "21000", effectiveGasPrice: "1", transferLogs });

test("an ERC-20 event keeps its full amount and emitting contract", () => {
  const big = 2n ** 255n + 7n;
  assert.deepEqual(decodeTransferLog({ logIndex: 4, address: token, topics: [TRANSFER_TOPIC, pad(a), pad(b)], data: word(big) }),
    { ordinal: 4, kind: "ERC20", token, sender: a, recipient: b, amount_atomic: big.toString(), token_id: null });
});

test("an ERC-721 event reads the token ID from the fourth topic", () => {
  assert.deepEqual(decodeTransferLog({ logIndex: 0, address: token, topics: [TRANSFER_TOPIC, pad(ZERO_ADDRESS), pad(b), word(42n)], data: "0x" }),
    { ordinal: 0, kind: "ERC721", token, sender: ZERO_ADDRESS, recipient: b, amount_atomic: null, token_id: "42" });
});

test("events that only share the signature are not read as transfers", () => {
  const log = { logIndex: 0, address: token, topics: [TRANSFER_TOPIC, pad(a), pad(b)], data: word(1n) };
  assert.equal(decodeTransferLog({ ...log, topics: [TRANSFER_TOPIC, `0x${"f".repeat(64)}`, pad(b)] }), null, "a topic that is not an address");
  assert.equal(decodeTransferLog({ ...log, data: "0x" }), null, "three topics without an amount");
  assert.equal(decodeTransferLog({ ...log, topics: [...log.topics, word(1n)] }), null, "four topics with data");
  assert.equal(decodeTransferLog({ ...log, topics: [TRANSFER_TOPIC, pad(a)] }), null, "missing recipient");
});

test("only a successful receipt yields transfers, and the native amount needs a recipient and a value", () => {
  const event = { logIndex: 3, address: token, topics: [TRANSFER_TOPIC, pad(a), pad(b)], data: word(5n) };
  const sent = { sender: a, recipient: b, value_atomic: "10" };
  assert.deepEqual(transfersOf(sent, receipt(1, [event])).map(t => [t.kind, t.ordinal]), [["NATIVE", -1], ["ERC20", 3]]);
  assert.deepEqual(transfersOf(sent, receipt(0, [event])), [], "a reverted transaction moved nothing");
  assert.deepEqual(transfersOf(sent, undefined), [], "unknown execution yields nothing");
  assert.deepEqual(transfersOf({ ...sent, value_atomic: "0" }, receipt(1)), [], "a zero native amount is not a transfer");
  assert.deepEqual(transfersOf({ ...sent, recipient: null }, receipt(1)), [], "a contract creation's value is not listed");
});

test("token parties join the transaction's addresses, except the zero address", () => {
  const hash = `0x${"1".repeat(64)}`;
  const mint = { logIndex: 0, address: token, topics: [TRANSFER_TOPIC, pad(ZERO_ADDRESS), pad(b)], data: word(1n) };
  const [tx] = projectBlock({ chain: "eip155:1", height: 10, hash: "h10", parentHeight: 9, parentHash: "h9",
    raw: { timestamp: "0x65", transactions: [{ hash, from: a, to: token, value: "0x0" }] }, receipts: [receipt(1, [mint])] });
  assert.deepEqual(tx?.addresses, [a, token, b]);
  assert.deepEqual(tx?.transfers.map(t => [t.kind, t.sender, t.recipient]), [["ERC20", ZERO_ADDRESS, b]]);
});
