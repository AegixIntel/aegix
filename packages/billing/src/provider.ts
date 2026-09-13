/**
 * Payment provider seam.
 *
 * The ledger, the plan catalog and entitlement enforcement never depend on
 * who collects the money. A provider does only what needs a processor: take
 * a payment (checkout), let the customer manage it (portal), change it on
 * the customer's behalf (cancel/resume), and report what happened (signed
 * webhooks) — each normalized into D11 vocabulary before the rest of billing
 * sees it (see provider-sync.ts).
 *
 * `manual` stays the default and stays valid next to any processor: operator
 * grants, recovery, local development and tests all go through it. It
 * involves no secret, network call or webhook, and `supportsSelfServe` is
 * false, so the API refuses to pretend an upgrade was paid for.
 *
 * This module holds the contract only. Implementations that perform I/O live
 * with the API (apps/api/src/billing-paddle.ts), keeping this package pure.
 */

import type { ProviderSubscriptionSnapshot } from "./provider-sync.js";
import { BillingError, type PlanDefinition } from "./types.js";

export interface CheckoutRequest {
  userId: string;
  plan: PlanDefinition;
  /**
   * Unguessable, server-generated token the processor carries through to the
   * subscription it creates. It is what binds a paid subscription to the
   * identity that started checkout; nothing the browser sends is.
   */
  checkoutToken: string;
}

export interface CheckoutSession {
  provider: string;
  /** Where the caller must send the customer to complete payment. */
  url: string;
  /** The processor's id for this checkout. */
  reference: string;
}

export interface PortalRequest {
  customerRef: string;
  subscriptionRef: string;
}

export interface PortalSession {
  url: string;
}

export type WebhookVerification = { valid: true } | { valid: false; reason: string };

interface WebhookEventBase {
  eventId: string;
  eventType: string;
  occurredAt: string;
}

export type ProviderWebhookEvent =
  | (WebhookEventBase & {
      kind: "subscription";
      snapshot: ProviderSubscriptionSnapshot;
      /** The processor checkout that created the subscription, when it says. */
      checkoutRef: string | null;
      checkoutToken: string | null;
    })
  | (WebhookEventBase & { kind: "unmapped"; subscriptionRef: string | null; reason: string })
  | (WebhookEventBase & { kind: "other" });

export interface ProviderWebhooks {
  /** Authenticates the exact bytes received. Nothing is parsed before this passes. */
  verify(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | string[] | undefined>>;
    now: Date;
  }): WebhookVerification;
  parse(rawBody: string): ProviderWebhookEvent | { kind: "invalid"; reason: string };
}

/** Browser-safe settings a hosted checkout script needs. Never a secret. */
export interface CheckoutClientConfig {
  environment: "sandbox" | "production";
  token: string;
}

export interface PaymentProvider {
  readonly name: string;
  /**
   * Whether a customer can start a paid subscription on their own. When
   * false, upgrades require an operator grant and the API says so plainly
   * rather than creating an unpaid paid-plan subscription.
   */
  readonly supportsSelfServe: boolean;
  readonly checkoutClient: CheckoutClientConfig | null;
  /** Signed callback handling; null for a provider that sends none. */
  readonly webhooks: ProviderWebhooks | null;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  createPortalSession(request: PortalRequest): Promise<PortalSession>;
  /** Asks the processor to cancel, and returns the state it reports back. */
  cancelSubscription(subscriptionRef: string, options: { immediate: boolean }): Promise<ProviderSubscriptionSnapshot>;
  /** Withdraws a scheduled cancellation, and returns the processor's state. */
  resumeSubscription(subscriptionRef: string): Promise<ProviderSubscriptionSnapshot>;
}

const MANUAL_REFUSAL = "This deployment has no payment provider configured; paid plans are granted by an operator";

/** Operator-granted plans; no payment processor is contacted. */
export function createManualProvider(): PaymentProvider {
  const refuse = async (): Promise<never> => {
    throw new BillingError("PAYMENT_PROVIDER_REQUIRED", MANUAL_REFUSAL);
  };
  return {
    name: "manual",
    supportsSelfServe: false,
    checkoutClient: null,
    webhooks: null,
    createCheckout: refuse,
    createPortalSession: refuse,
    cancelSubscription: refuse,
    resumeSubscription: refuse
  };
}
