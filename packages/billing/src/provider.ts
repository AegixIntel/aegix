/**
 * Payment provider seam.
 *
 * architecture.md PR-12 holds payment infrastructure out of this baseline:
 * the beta operates without it. D11 therefore ships the ledger, the plan
 * catalog and entitlement enforcement — the parts the product needs whether
 * or not money is being collected — behind an interface a real processor can
 * implement later without touching routes, repositories or the state machine.
 *
 * The only shipped implementation is `manual`: plans are granted by an
 * operator, recorded in `billing_events` like any other transition, and no
 * secret, network call or webhook is involved. `supportsSelfServe` is false,
 * so the API refuses to pretend an upgrade was paid for.
 */

import { BillingError, type PlanDefinition } from "./types.js";

export interface CheckoutRequest {
  userId: string;
  plan: PlanDefinition;
  returnUrl: string;
}

export interface CheckoutSession {
  provider: string;
  /** Where the caller must send the customer to complete payment. */
  url: string;
  reference: string;
}

export interface PaymentProvider {
  readonly name: string;
  /**
   * Whether a customer can start a paid subscription on their own. When
   * false, upgrades require an operator grant and the API says so plainly
   * rather than creating an unpaid paid-plan subscription.
   */
  readonly supportsSelfServe: boolean;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
}

/** Operator-granted plans; no payment processor is contacted. */
export function createManualProvider(): PaymentProvider {
  return {
    name: "manual",
    supportsSelfServe: false,
    async createCheckout() {
      throw new BillingError(
        "PAYMENT_PROVIDER_REQUIRED",
        "This deployment has no payment provider configured; paid plans are granted by an operator"
      );
    }
  };
}
