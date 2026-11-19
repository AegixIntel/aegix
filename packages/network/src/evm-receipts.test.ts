import test from "node:test";
import assert from "node:assert/strict";
import { slimEvmBlock, transactionHashOf, trimReceipts, TRANSFER_TOPIC } from "./evm-receipts.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const BLOCK = hash(0xb10c);
const block = { hash: BLOCK, number: "0xa", transactions: [{ hash: hash(1), from: address(1) }, { hash: hash(2), from: address(2) }] };

function receipt(position: number, overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: hash(position + 1), transactionIndex: `0x${position.toString(16)}`, blockHash: BLOCK,
    status: "0x1", from: address(position + 1).toUpperCase().replace("0X", "0x"), gasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca00", logsBloom: `0x${"0".repeat(512)}`, logs: [], ...overrides
  };
}

test("receipts are kept in block order with status, gas and the sender", () => {
  const trimmed = trimReceipts(block, [receipt(0), receipt(1, { status: "0x0" })]);
  assert.equal(trimmed.length, 2);
  assert.deepEqual(trimmed.map(r => r.status), [1, 0]);
  assert.equal(trimmed[0]?.gasUsed, "21000");
  assert.equal(trimmed[0]?.effectiveGasPrice, "1000000000");
  assert.equal(trimmed[0]?.from, address(1), "the sender is lowercased");
  assert.equal("logsBloom" in (trimmed[0] as object), false, "the bloom filter is dropped");
});

test("only Transfer logs survive, lowercased and with their index", () => {
  const transfer = { logIndex: "0x3", address: address(0xc0de).toUpperCase().replace("0X", "0x"),
    topics: [TRANSFER_TOPIC, hash(0xa), hash(0xb)], data: `0x${"0".repeat(63)}1` };
  const approval = { logIndex: "0x4", address: address(0xc0de), topics: [hash(0xdead)], data: "0x" };
  const anonymous = { logIndex: "0x5", address: address(0xc0de), topics: [], data: "0x" };
  const [first] = trimReceipts(block, [receipt(0, { logs: [transfer, approval, anonymous] }), receipt(1)]);
  assert.equal(first?.transferLogs.length, 1);
  assert.deepEqual(first?.transferLogs[0], { logIndex: 3, address: address(0xc0de), topics: transfer.topics, data: transfer.data });
});

test("a receipt list that is not exactly the block's fails the batch", () => {
  assert.throws(() => trimReceipts(block, [receipt(0)]), /count 1 does not match 2/);
  assert.throws(() => trimReceipts(block, [receipt(1), receipt(0)]), /different transaction/);
  assert.throws(() => trimReceipts(block, [receipt(0), receipt(1, { blockHash: hash(9) })]), /different block/);
  assert.throws(() => trimReceipts(block, [receipt(0), receipt(1, { transactionIndex: "0x0" })]), /out of order/);
  assert.throws(() => trimReceipts(block, null), /receipt list/);
});

test("a receipt without a usable status is never read as success or failure", () => {
  assert.throws(() => trimReceipts(block, [receipt(0, { status: undefined, root: hash(5) }), receipt(1)]), /receipt status/);
  assert.throws(() => trimReceipts(block, [receipt(0, { status: "0x2" }), receipt(1)]), /receipt status/);
});

test("a removed log in a finalized receipt is rejected", () => {
  const removed = { logIndex: "0x0", address: address(1), topics: [TRANSFER_TOPIC], data: "0x", removed: true };
  assert.throws(() => trimReceipts(block, [receipt(0, { logs: [removed] }), receipt(1)]), /Removed log/);
});

test("the stored EVM block keeps transaction hashes only", () => {
  const slim = slimEvmBlock(block);
  assert.deepEqual(slim.transactions, [hash(1), hash(2)]);
  assert.equal(slim.hash, BLOCK);
  assert.equal(transactionHashOf(hash(3)), hash(3), "a block of hashes is accepted as is");
});
