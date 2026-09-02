/**
 * Webhook delivery (D6-H), see docs/d6-block2.md.
 *
 * Async delivery through the dedicated `webhooks` BullMQ queue so a broken
 * customer endpoint can never starve monitor/intelligence workers (§107,
 * §122). SSRF protection at delivery time (§115-§118): resolve → validate
 * IP → connect; redirects disabled; intentional port policy.
 */

export {
  processWebhookDelivery,
  enqueueWebhookDelivery,
  resolveWebhookDestination,
  deliverWebhookOnce,
  isTransientStatus,
  isPermanentStatus,
  SsrfBlockedError,
  type WebhookDeliveryContext,
  type WebhookEventPayload
} from "@aegix/webhook-delivery";
