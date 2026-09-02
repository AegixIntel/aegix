import type { Job } from "bullmq";
import type { WebhookJobData } from "@aegix/queue";
import type { ProcessorContext } from "../worker.js";

/** Webhook delivery processor (D6-H §107-§113). The delivery logic lives
 *  in apps/api/src/webhook-delivery.ts (shared with the API's enqueue
 *  path); the worker only delegates. */
export async function processWebhookJob(job: Job<WebhookJobData>, ctx: ProcessorContext): Promise<void> {
  const { processWebhookDelivery } = await import("@aegix/webhook-delivery");
  await processWebhookDelivery(ctx, job.data);
}
