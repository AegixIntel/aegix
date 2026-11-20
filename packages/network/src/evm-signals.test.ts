import test from "node:test";
import assert from "node:assert/strict";
import { walletSignals, type SignalTransfer } from "./evm-signals.js";
import { ZERO_ADDRESS } from "./evm-transfers.js";

const wallet = `0x${"a".repeat(40)}`;
const friend = `0x1234${"5".repeat(32)}abcd`;
const lookAlike = `0x1234${"9".repeat(32)}abcd`;
const funder = `0x${"f".repeat(40)}`;
const token = `0x${"c".repeat(40)}`;
let next = 0;
const transfer = (over: Partial<SignalTransfer>): SignalTransfer => ({ tx_id: `0x${(next++).toString(16).padStart(64, "0")}`, ordinal: -1,
  height: 100, kind: "NATIVE", token: null, sender: wallet, recipient: friend, amount_atomic: "1", tx_sender: wallet, ...over });

test("activity, native totals, counterparties and earliest funding", () => {
  const signals = walletSignals(wallet, [
    transfer({ height: 103, amount_atomic: "5" }),
    transfer({ height: 101, sender: funder, recipient: wallet, amount_atomic: "100", tx_sender: funder }),
    transfer({ height: 102, sender: funder, recipient: wallet, amount_atomic: "7", tx_sender: funder }),
    transfer({ height: 104, kind: "ERC20", token, ordinal: 3, sender: ZERO_ADDRESS, recipient: wallet, amount_atomic: "9", tx_sender: funder }),
    transfer({ height: 105, sender: wallet, recipient: wallet, amount_atomic: "1" })
  ], false);
  assert.deepEqual(signals.activity, { incoming: 3, outgoing: 1, self: 1, nativeIn: "107", nativeOut: "5", tokenContracts: 1, zeroAmountIncoming: 0 });
  assert.equal(signals.earliestFunding?.sender, funder);
  assert.equal(signals.earliestFunding?.height, 101);
  assert.deepEqual(signals.counterparties.map(c => [c.address, c.incoming, c.outgoing]), [[funder, 2, 0], [friend, 0, 1]],
    "the zero address (mint) is not a counterparty, and the busiest comes first");
  assert.deepEqual(signals.sample, { transfers: 5, truncated: false, fromHeight: 101, toHeight: 105 });
  assert.deepEqual(signals.lookAlikes, []);
});

test("a look-alike of a genuine recipient is listed, whichever direction it appears in", () => {
  const signals = walletSignals(wallet, [
    transfer({ height: 100, amount_atomic: "50" }),
    transfer({ height: 101, kind: "ERC20", token, ordinal: 0, sender: lookAlike, recipient: wallet, amount_atomic: "0", tx_sender: lookAlike }),
    // A spoofed zero-amount event "from" the wallet, in a transaction it did not sign.
    transfer({ height: 102, kind: "ERC20", token, ordinal: 1, sender: wallet, recipient: lookAlike, amount_atomic: "0", tx_sender: lookAlike })
  ], false);
  assert.deepEqual(signals.lookAlikes.map(l => [l.address, l.imitates, l.direction, l.zeroAmount]),
    [[lookAlike, friend, "IN", true], [lookAlike, friend, "OUT", true]]);
  assert.equal(signals.activity.zeroAmountIncoming, 1);
});

test("a counterparty is genuine only when the wallet signed a non-zero transfer to it", () => {
  const signals = walletSignals(wallet, [
    // Zero amount, and an event in someone else's transaction: neither makes `friend` genuine.
    transfer({ amount_atomic: "0" }),
    transfer({ kind: "ERC20", token, ordinal: 2, amount_atomic: "10", tx_sender: funder }),
    transfer({ sender: lookAlike, recipient: wallet, amount_atomic: "1", tx_sender: lookAlike })
  ], true);
  assert.deepEqual(signals.lookAlikes, []);
  assert.equal(signals.sample.truncated, true);
});
