import type postgres from "postgres";
import type { IndexCheckpoint, IndexStore } from "./indexer.js";
import { height } from "./indexer.js";
import { persistProjection } from "./projection.js";

export function createIndexStore(sql: postgres.Sql): IndexStore {
  return {
    async checkpoint(chain, start) {
      await sql`insert into network_checkpoints (chain, start_height, next_height)
        values (${chain}, ${start}, ${start}) on conflict (chain) do nothing`;
      const [row] = await sql`select * from network_checkpoints where chain = ${chain}`;
      if (!row) throw new Error("Missing index checkpoint");
      if (Number(row.start_height) !== start) throw new Error("Start height differs from existing checkpoint");
      return {
        nextHeight: height(Number(row.next_height)),
        lastHeight: row.last_height === null ? null : height(Number(row.last_height)),
        lastHash: row.last_hash as string | null
      };
    },
    async commit(chain, expected: IndexCheckpoint, next, blocks) {
      height(next);
      if (next <= expected.nextHeight || blocks.some(block => block.chain !== chain || block.height < expected.nextHeight || block.height >= next)) throw new Error("Invalid checkpoint range");
      await sql.begin(async tx => {
        const [row] = await tx`select * from network_checkpoints where chain = ${chain} for update`;
        if (!row || Number(row.next_height) !== expected.nextHeight || row.last_hash !== expected.lastHash) {
          throw new Error("Checkpoint changed; retry batch");
        }
        for (const block of blocks) {
          await tx`insert into network_blocks (chain, height, hash, parent_height, parent_hash, raw, raw_rpc)
            values (${chain}, ${block.height}, ${block.hash}, ${block.parentHeight}, ${block.parentHash},
              ${tx.json(JSON.parse(JSON.stringify(block.raw)))}, ${block.rawRpc ?? null})`;
          await persistProjection(tx, block);
        }
        const last = blocks.at(-1);
        await tx`update network_checkpoints set next_height = ${next},
          last_height = ${last?.height ?? expected.lastHeight}, last_hash = ${last?.hash ?? expected.lastHash},
          updated_at = now() where chain = ${chain}`;
      });
    }
  };
}
