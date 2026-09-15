import postgres from "postgres";
import { parseChain } from "./chains.js";

async function main() {
  if (!process.env.DATABASE_URL || !process.env.INDEXER_CHAIN) throw new Error("Indexer configuration missing");
  const chain = parseChain(process.env.INDEXER_CHAIN);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 5 });
  try {
    const [row] = await sql`select last_error, heartbeat_at > now() - interval '3 minutes' as fresh
      from network_checkpoints where chain = ${chain}`;
    if (!row?.fresh || row.last_error) throw new Error("Indexer is not healthy");
  } finally { await sql.end(); }
}
main().catch(() => { console.error("Indexer heartbeat is stale, missing or reporting an error"); process.exitCode = 1; });
