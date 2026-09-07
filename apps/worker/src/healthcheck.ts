import { loadConfig } from "@aegix/config";
import { createDb } from "@aegix/database";
import { createQueues } from "@aegix/queue";
import { isFreshHeartbeat, workerHeartbeatKey } from "./health.js";

const config = loadConfig();
const sql = createDb(config.DATABASE_URL);
const queues = createQueues(config);

async function check(): Promise<void> {
  await sql`select 1`;
  await queues.monitoring.getJobCounts();
  const client = await queues.monitoring.client;
  const heartbeat = await client.get(workerHeartbeatKey(config));
  if (!isFreshHeartbeat(heartbeat)) throw new Error("worker heartbeat is stale or missing");
}

check()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "worker healthcheck failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await queues.close().catch(() => {});
    await sql.end().catch(() => {});
  });
