import type postgres from "postgres";
import { CHAINS, walletIdentity } from "./chains.js";
import type { IndexedBlock } from "./indexer.js";
import { jsonbSafe } from "./jsonb.js";
import { transfersOf, ZERO_ADDRESS, type ProjectedTransfer } from "./evm-transfers.js";

export interface ProjectedTransaction {
  tx_id: string; height: number; position: number; block_time: string | null;
  success: boolean | null; sender: string | null; recipient: string | null;
  value_atomic: string | null; addresses: string[]; raw: unknown;
  /** EVM only: native and token transfers of a successful transaction. */
  transfers: ProjectedTransfer[];
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed block transaction");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Missing transaction identity");
  return value;
}
/** Membership is observable involvement, never proof of ownership or a transfer. */
export function projectBlock(block: IndexedBlock): ProjectedTransaction[] {
  const raw = record(block.raw);
  if (!Array.isArray(raw.transactions)) throw new Error("Missing transactions");
  const solana = CHAINS[block.chain].family === "solana";
  const timestamp = solana ? raw.blockTime : typeof raw.timestamp === "string" ? Number(BigInt(raw.timestamp)) : null;
  const blockTime = typeof timestamp === "number" && Number.isSafeInteger(timestamp) ? new Date(timestamp * 1000).toISOString() : null;
  const canonical = (value: unknown) => {
    const address = text(value);
    walletIdentity(block.chain, address);
    return solana ? address : address.toLowerCase();
  };
  if (!solana && raw.transactions.some(entry => typeof entry === "string")) {
    // A stored EVM block keeps hashes only; it was projected when it was written.
    throw new Error("A stored EVM block keeps transaction hashes only and cannot be re-projected");
  }
  if (!solana && block.receipts && block.receipts.length !== raw.transactions.length) throw new Error("Receipts do not match block transactions");
  return raw.transactions.map((entry: unknown, position: number) => {
    const item = record(entry);
    if (solana) {
      const transaction = record(item.transaction);
      const message = record(transaction.message);
      const keys = message.accountKeys;
      if (!Array.isArray(keys) || !Array.isArray(transaction.signatures)) throw new Error("Invalid Solana transaction");
      const meta = item.meta === null ? null : record(item.meta);
      const loaded = meta?.loadedAddresses ? record(meta.loadedAddresses) : {};
      const addresses = [...keys.map(key => canonical(typeof key === "string" ? key : record(key).pubkey)),
        ...[loaded.writable, loaded.readonly].flatMap(list => Array.isArray(list) ? list.map(canonical) : [])];
      return { tx_id: text(transaction.signatures[0]), height: block.height, position,
        block_time: blockTime, success: meta && Object.hasOwn(meta, "err") ? meta.err === null : null,
        sender: null, recipient: null, value_atomic: null, addresses: [...new Set(addresses)], transfers: [],
        raw: { ...item, slot: block.height, blockTime: timestamp } };
    }
    const sender = canonical(item.from);
    const recipient = item.to === null ? null : canonical(item.to);
    const value = text(item.value);
    if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid EVM value");
    // Only a receipt says whether it executed; without one, never claim it did.
    const receipt = block.receipts?.[position];
    const txId = text(item.hash);
    if (receipt && receipt.transactionHash !== txId.toLowerCase()) throw new Error("Receipt does not match its transaction");
    const valueAtomic = BigInt(value).toString();
    const transfers = transfersOf({ sender, recipient, value_atomic: valueAtomic }, receipt);
    // A token transfer involves its parties even when neither sent the
    // transaction. The zero address (mint and burn) would gather a membership
    // row for every such event, so it appears in transfers only.
    const parties = transfers.flatMap(t => [t.sender, t.recipient]).filter(a => a !== ZERO_ADDRESS);
    return { tx_id: txId, height: block.height, position, block_time: blockTime,
      success: receipt ? receipt.status === 1 : null, sender, recipient, value_atomic: valueAtomic,
      addresses: [...new Set([sender, ...(recipient ? [recipient] : []), ...parties])], raw: item, transfers };
  });
}

export async function persistProjection(tx: postgres.TransactionSql, block: IndexedBlock): Promise<void> {
  const projected = projectBlock(block);
  // Chunk to bound statement parameters and memory on busy Solana blocks.
  for (let offset = 0; offset < projected.length; offset += 100) {
    const slice = projected.slice(offset, offset + 100);
    const rows = slice.map(({ addresses: _addresses, transfers: _transfers, ...row }) => ({ ...row, chain: block.chain }));
    await tx`insert into network_transactions
      select chain, tx_id, height, position, block_time, success, sender, recipient, value_atomic, raw
      from jsonb_to_recordset(${tx.json(jsonbSafe(rows))}) as x(
        chain text, tx_id text, height bigint, position integer, block_time timestamptz,
        success boolean, sender text, recipient text, value_atomic text, raw jsonb)`;
    const memberships = slice.flatMap(row => row.addresses.map(address => ({ chain: block.chain, address, tx_id: row.tx_id, height: row.height, position: row.position })));
    if (memberships.length) await tx`insert into network_transaction_addresses
      select chain, address, tx_id, height, position
      from jsonb_to_recordset(${tx.json(memberships)}) as x(chain text, address text, tx_id text, height bigint, position integer)`;
    const transfers = slice.flatMap(row => row.transfers.map(t => ({ ...t, chain: block.chain, tx_id: row.tx_id, height: row.height, position: row.position })));
    if (transfers.length) await tx`insert into network_transfers
      select chain, tx_id, ordinal, height, position, kind, token, sender, recipient, amount_atomic, token_id
      from jsonb_to_recordset(${tx.json(transfers)}) as x(chain text, tx_id text, ordinal integer, height bigint, position integer,
        kind text, token text, sender text, recipient text, amount_atomic text, token_id text)`;
  }
  await tx`insert into network_projections (chain, height) values (${block.chain}, ${block.height})`;
}
