/**
 * Value movements read from an EVM transaction and its receipt.
 *
 * Two sources, both taken only from a successful receipt:
 *  - the native amount the transaction itself sent (`value`), and
 *  - ERC-20 / ERC-721 `Transfer` events the receipt carries.
 *
 * A reverted transaction moved nothing, and a transaction without a receipt
 * has unknown execution, so neither yields a transfer. Value moved by internal
 * calls is not visible without tracing and is never inferred.
 *
 * Any contract can emit a `Transfer` event, so an event is a claim by its
 * emitting contract, not proof that a real token moved. The emitting address
 * is kept so a reader can judge the contract.
 */
import type { EvmReceipt, EvmTransferLog } from "./evm-receipts.js";

export type TransferKind = "NATIVE" | "ERC20" | "ERC721";

export interface ProjectedTransfer {
  /** -1 for the native amount, otherwise the event's log index in the block. */
  ordinal: number;
  kind: TransferKind;
  /** Emitting contract for token events; null for the native amount. */
  token: string | null;
  sender: string;
  recipient: string;
  /** Smallest unit, decimal string. Null for ERC-721. */
  amount_atomic: string | null;
  /** ERC-721 token ID, decimal string. */
  token_id: string | null;
}

export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const PADDED_ADDRESS = /^0x0{24}([0-9a-f]{40})$/;
const WORD = /^0x[0-9a-f]{64}$/;

/** A topic holds an address only when its upper 12 bytes are zero. */
function topicAddress(topic: string | undefined): string | null {
  const match = topic === undefined ? null : PADDED_ADDRESS.exec(topic);
  return match ? `0x${match[1]}` : null;
}

/**
 * ERC-20 puts the amount in `data` with three topics; ERC-721 indexes the
 * token ID as a fourth topic with empty data. Anything else that shares the
 * signature is not read as a transfer.
 */
export function decodeTransferLog(log: EvmTransferLog): ProjectedTransfer | null {
  const sender = topicAddress(log.topics[1]);
  const recipient = topicAddress(log.topics[2]);
  if (!sender || !recipient) return null;
  if (log.topics.length === 3 && WORD.test(log.data)) {
    return { ordinal: log.logIndex, kind: "ERC20", token: log.address, sender, recipient,
      amount_atomic: BigInt(log.data).toString(), token_id: null };
  }
  if (log.topics.length === 4 && log.data === "0x") {
    return { ordinal: log.logIndex, kind: "ERC721", token: log.address, sender, recipient,
      amount_atomic: null, token_id: BigInt(log.topics[3]!).toString() };
  }
  return null;
}

export function transfersOf(transaction: { sender: string; recipient: string | null; value_atomic: string | null },
  receipt: EvmReceipt | undefined): ProjectedTransfer[] {
  if (!receipt || receipt.status !== 1) return [];
  const transfers: ProjectedTransfer[] = [];
  // A contract creation (no recipient) sends its value to an address the
  // receipt names but this index does not keep, so it is not listed.
  if (transaction.recipient && transaction.value_atomic && BigInt(transaction.value_atomic) > 0n) {
    transfers.push({ ordinal: -1, kind: "NATIVE", token: null, sender: transaction.sender,
      recipient: transaction.recipient, amount_atomic: transaction.value_atomic, token_id: null });
  }
  for (const log of receipt.transferLogs) {
    const transfer = decodeTransferLog(log);
    if (transfer) transfers.push(transfer);
  }
  return transfers;
}
