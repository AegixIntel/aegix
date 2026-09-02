import type { Job } from "bullmq";
import type { WebhookJobData } from "@aegix/queue";
import type { ProcessorContext } from "../worker.js";

/** Webhook delivery processor (D6-H §107-§113). The delivery logic lives
 *  in @aegix/webhook-delivery (shared with the API's enqueue path); the
 *  worker only delegates. attemptsMade is passed through so the delivery
 *  audit trail records the REAL attempt number on every retry (D6-J fix:
 *  previously every BullMQ retry was recorded as attempt 1). */
export async function processWebhookJob(job: Job<WebhookJobData>, ctx: ProcessorContext): Promise<void> {
  const { processWebhookDelivery } = await import("@aegix/webhook-delivery");
  await processWebhookDelivery(ctx, job.data, { attempt: Math.max(1, (job.attemptsMade ?? 0) + 1) });
}
