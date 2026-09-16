import type postgres from "postgres";
import { CHAINS, walletIdentity } from "./chains.js";
import type { IndexedBlock } from "./indexer.js";
import { jsonbSafe } from "./jsonb.js";

export interface ProjectedTransaction {
  tx_id: string; height: number; position: number; block_time: string | null;
  success: boolean | null; sender: string | null; recipient: string | null;
  value_atomic: string | null; addresses: string[]; raw: unknown;
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
        sender: null, recipient: null, value_atomic: null, addresses: [...new Set(addresses)],
        raw: { ...item, slot: block.height, blockTime: timestamp } };
    }
    const sender = canonical(item.from);
    const recipient = item.to === null ? null : canonical(item.to);
    const value = text(item.value);
    if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error("Invalid EVM value");
    // A transaction in a block has no receipt status. Never claim it succeeded.
    return { tx_id: text(item.hash), height: block.height, position, block_time: blockTime,
      success: null, sender, recipient, value_atomic: BigInt(value).toString(),
      addresses: [...new Set([sender, ...(recipient ? [recipient] : [])])], raw: item };
  });
}

export async function persistProjection(tx: postgres.TransactionSql, block: IndexedBlock): Promise<void> {
  const projected = projectBlock(block);
  // Chunk to bound statement parameters and memory on busy Solana blocks.
  for (let offset = 0; offset < projected.length; offset += 100) {
    const slice = projected.slice(offset, offset + 100);
    const rows = slice.map(({ addresses: _addresses, ...row }) => ({ ...row, chain: block.chain }));
    await tx`insert into network_transactions
      select chain, tx_id, height, position, block_time, success, sender, recipient, value_atomic, raw
      from jsonb_to_recordset(${tx.json(jsonbSafe(rows))}) as x(
        chain text, tx_id text, height bigint, position integer, block_time timestamptz,
        success boolean, sender text, recipient text, value_atomic text, raw jsonb)`;
    const memberships = slice.flatMap(row => row.addresses.map(address => ({ chain: block.chain, address, tx_id: row.tx_id, height: row.height, position: row.position })));
    if (memberships.length) await tx`insert into network_transaction_addresses
      select chain, address, tx_id, height, position
      from jsonb_to_recordset(${tx.json(memberships)}) as x(chain text, address text, tx_id text, height bigint, position integer)`;
  }
  await tx`insert into network_projections (chain, height) values (${block.chain}, ${block.height})`;
}
