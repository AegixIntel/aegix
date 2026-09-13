/**
 * Manual settlement: what a confirmed invoice payment does to the
 * subscription.
 *
 * A manually provisioned subscription does not renew on time alone. When an
 * operator confirms payment on an invoice, this decides which canonical
 * transition starts the next paid period:
 *
 *   subscription live    → RENEW     (advance exactly one interval)
 *   subscription ended   → SUBSCRIBE (a fresh period; EXPIRED is terminal)
 *
 * It deliberately returns an existing action rather than introducing a new
 * one, so a paid renewal and an operator grant are recorded by the same state
 * machine and the same ledger. It is pure — persistence, the event key and
 * the invoice state are the caller's job.
 */

import type { BillingAction, SubscriptionState } from "./types.js";

export function paidRenewalAction(subscription: SubscriptionState | null): BillingAction {
  if (!subscription || subscription.status === "EXPIRED") return "SUBSCRIBE";
  return "RENEW";
}
