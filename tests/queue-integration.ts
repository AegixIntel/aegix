import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { QueueEvents, Worker } from "bullmq";
import { loadConfig } from "@aegix/config";
import { createQueues, publishToDeadLetter } from "@aegix/queue";
import { isFinalJobFailure } from "../apps/worker/src/failure.js";

async function main(): Promise<void> {
  const prefix = `aegix-release-${randomUUID()}`;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    QUEUE_PREFIX: prefix,
    REDIS_QUEUE_DB: "1"
  });
  const connection = { url: config.REDIS_URL, db: config.REDIS_QUEUE_DB };
  const queues = createQueues(config);
  const events = new QueueEvents("analysis.standard", { connection, prefix });
  await events.waitUntilReady();

  let retryAttempts = 0;
  let resolveFinalFailure!: () => void;
  let rejectFinalFailure!: (error: unknown) => void;
  const finalFailurePublished = new Promise<void>((resolve, reject) => {
    resolveFinalFailure = resolve;
    rejectFinalFailure = reject;
  });
  const worker = new Worker(
    "analysis.standard",
    async (job) => {
      if (job.name === "retry-once" && retryAttempts++ === 0) throw new Error("transient test failure");
      if (job.name === "always-fail") throw new Error("terminal test failure");
    },
    { connection, prefix, concurrency: 1 }
  );

  worker.on("failed", (job, error) => {
    if (job?.name !== "always-fail" || !isFinalJobFailure(job)) return;
    void publishToDeadLetter(queues, {
      jobId: job.id ?? "unknown",
      analysisId: null,
      walletShort: null,
      walletHash: null,
      originalQueue: worker.name,
      stage: "integration-test",
      errorCode: "ENGINE_FAILURE",
      error: error.message,
      attempts: job.attemptsMade,
      provider: null,
      timestamp: new Date().toISOString()
    }).then(resolveFinalFailure, rejectFinalFailure);
  });

  try {
    const dedupA = await queues.analysisStandard.add("consume", {
      analysisId: randomUUID(), walletAddress: "wallet-a", chain: "solana", analysisType: "full"
    }, { jobId: "dedup-job", removeOnComplete: false });
    const dedupB = await queues.analysisStandard.add("consume", {
      analysisId: randomUUID(), walletAddress: "wallet-b", chain: "solana", analysisType: "full"
    }, { jobId: "dedup-job", removeOnComplete: false });
    assert.equal(dedupA.id, dedupB.id, "duplicate jobId resolves to one BullMQ job");
    await dedupA.waitUntilFinished(events, 10_000);

    const retry = await queues.analysisStandard.add("retry-once", {
      analysisId: randomUUID(), walletAddress: "wallet-c", chain: "solana", analysisType: "full"
    }, { attempts: 2, backoff: { type: "fixed", delay: 25 }, removeOnComplete: false });
    await retry.waitUntilFinished(events, 10_000);
    assert.equal(retryAttempts, 2, "transient failure is retried exactly once");

    const failure = await queues.analysisStandard.add("always-fail", {
      analysisId: randomUUID(), walletAddress: "wallet-d", chain: "solana", analysisType: "full"
    }, { attempts: 2, backoff: { type: "fixed", delay: 25 }, removeOnFail: false });
    await assert.rejects(() => failure.waitUntilFinished(events, 10_000), /terminal test failure/);
    await finalFailurePublished;
    const dlq = await queues.deadLetter.getJobs(["waiting", "delayed", "completed", "failed"]);
    assert.equal(dlq.length, 1, "one terminal failure produces one DLQ record, not one per attempt");
    assert.equal(dlq[0]?.data.attempts, 2);

    await worker.close();
    await events.close();
    await queues.close();

    const reconnected = createQueues(config);
    const counts = await reconnected.analysisStandard.getJobCounts();
    assert.ok(typeof counts.completed === "number", "queue reconnect exposes job counts");
    await Promise.all([
      reconnected.analysisHigh,
      reconnected.analysisStandard,
      reconnected.analysisFree,
      reconnected.refresh,
      reconnected.monitoring,
      reconnected.reportGeneration,
      reconnected.webhooks,
      reconnected.deadLetter
    ].map((queue) => queue.obliterate({ force: true })));
    await reconnected.close();

    console.log("BullMQ enqueue, consume, dedup, retry, terminal failure, DLQ, close, and reconnect passed");
  } finally {
    await worker.close().catch(() => {});
    await events.close().catch(() => {});
    await queues.close().catch(() => {});
  }
}

void main();
