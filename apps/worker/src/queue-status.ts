import { loadConfig } from "@aegix/config";
import { createQueues } from "@aegix/queue";

const config = loadConfig();
const queues = createQueues(config);

const entries = {
  "analysis.high": queues.analysisHigh,
  "analysis.standard": queues.analysisStandard,
  "analysis.free": queues.analysisFree,
  refresh: queues.refresh,
  monitoring: queues.monitoring,
  "report-generation": queues.reportGeneration,
  webhooks: queues.webhooks,
  "dead-letter": queues.deadLetter
};

try {
  const status = Object.fromEntries(await Promise.all(
    Object.entries(entries).map(async ([name, queue]) => [name, await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed")])
  ));
  console.log(JSON.stringify(status, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "queue status failed");
  process.exitCode = 1;
} finally {
  await queues.close().catch(() => {});
}
