/**
 * EVM receipts, checked against their block and trimmed to what AEGIX reads.
 *
 * A block's transactions say what was requested; only the receipt says what
 * executed. A receipt list is accepted only when it is exactly the block's:
 * same count, same order, same transaction hashes, same block hash. Anything
 * else fails the batch, so a partial or foreign list can never be read as the
 * block's execution record.
 *
 * Trimming: `logsBloom` (512 bytes per receipt) and every log that is not an
 * ERC-20/ERC-721 `Transfer` are dropped. On a live mainnet sample the raw
 * receipts were larger than the block itself (557 KB against 338 KB).
 */

/** keccak256("Transfer(address,address,uint256)") — shared by ERC-20 and ERC-721. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface EvmTransferLog {
  logIndex: number;
  /** Emitting contract, lowercased. */
  address: string;
  topics: string[];
  data: string;
}

export interface EvmReceipt {
  transactionHash: string;
  transactionIndex: number;
  /** 1 executed, 0 reverted. */
  status: 0 | 1;
  /** Lowercased sender as the receipt reports it. */
  from: string;
  /** Decimal strings: gas quantities can exceed 2^53 when multiplied out. */
  gasUsed: string;
  effectiveGasPrice: string | null;
  transferLogs: EvmTransferLog[];
}

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const DATA = /^0x(?:[0-9a-f]{2})*$/i;

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid EVM ${what}`);
  return value as Record<string, unknown>;
}
function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !HEX_QUANTITY.test(value)) throw new Error(`Invalid EVM ${what}`);
  return BigInt(value);
}
function safeIndex(value: unknown, what: string): number {
  const n = quantity(value, what);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid EVM ${what}`);
  return Number(n);
}
function matching(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid EVM ${what}`);
  return value.toLowerCase();
}

/** The hash of a block transaction, whether the block carries full objects or hashes. */
export function transactionHashOf(entry: unknown): string {
  return matching(typeof entry === "string" ? entry : object(entry, "transaction").hash, HASH, "transaction hash");
}

function trimLog(value: unknown): EvmTransferLog | null {
  const log = object(value, "log");
  if (log.removed === true) throw new Error("Removed log in a finalized receipt");
  if (!Array.isArray(log.topics) || log.topics.length === 0) return null;
  const topics = log.topics.map(topic => matching(topic, HASH, "log topic"));
  if (topics[0] !== TRANSFER_TOPIC) return null;
  return { logIndex: safeIndex(log.logIndex, "log index"), address: matching(log.address, ADDRESS, "log address"),
    topics, data: matching(log.data, DATA, "log data") };
}

export function trimReceipts(block: Record<string, unknown>, raw: unknown): EvmReceipt[] {
  const transactions: unknown[] = Array.isArray(block.transactions) ? block.transactions : [];
  if (!Array.isArray(block.transactions)) throw new Error("Missing block transactions");
  if (!Array.isArray(raw)) throw new Error("Invalid EVM receipt list");
  if (raw.length !== transactions.length) {
    throw new Error(`Receipt count ${raw.length} does not match ${transactions.length} block transactions`);
  }
  const blockHash = matching(block.hash, HASH, "block hash");
  return raw.map((value, position) => {
    const receipt = object(value, "receipt");
    const transactionHash = matching(receipt.transactionHash, HASH, "receipt transaction hash");
    if (transactionHash !== transactionHashOf(transactions[position])) {
      throw new Error(`Receipt ${position} belongs to a different transaction`);
    }
    if (matching(receipt.blockHash, HASH, "receipt block hash") !== blockHash) throw new Error(`Receipt ${position} belongs to a different block`);
    if (safeIndex(receipt.transactionIndex, "receipt index") !== position) throw new Error(`Receipt ${position} is out of order`);
    // Pre-Byzantium receipts carry a state root instead of a status; they are
    // not read as success or failure.
    const status = quantity(receipt.status, "receipt status");
    if (status !== 0n && status !== 1n) throw new Error("Invalid EVM receipt status");
    if (!Array.isArray(receipt.logs)) throw new Error("Invalid EVM receipt logs");
    return {
      transactionHash, transactionIndex: position, status: status === 1n ? 1 : 0,
      from: matching(receipt.from, ADDRESS, "receipt sender"),
      gasUsed: quantity(receipt.gasUsed, "gas used").toString(),
      effectiveGasPrice: receipt.effectiveGasPrice == null ? null : quantity(receipt.effectiveGasPrice, "gas price").toString(),
      transferLogs: receipt.logs.map(trimLog).filter((log): log is EvmTransferLog => log !== null)
    };
  });
}

/**
 * What `network_blocks.raw` keeps for an EVM block: the header with
 * transaction hashes only. Every transaction is already stored whole in
 * `network_transactions.raw`, in the same database transaction, so keeping it
 * twice only doubled the block's footprint.
 */
export function slimEvmBlock(raw: unknown): Record<string, unknown> {
  const block = object(raw, "block");
  if (!Array.isArray(block.transactions)) throw new Error("Missing block transactions");
  return { ...block, transactions: block.transactions.map(transactionHashOf) };
}
