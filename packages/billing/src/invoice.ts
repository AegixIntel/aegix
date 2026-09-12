/**
 * Invoice arithmetic, architecture.md §69.
 *
 * An invoice is derived, never accumulated: given a plan, a period and the
 * metered usage for that period, `computeInvoice` produces the same lines
 * every time it runs. That makes reissuing an invoice safe and makes a
 * disagreement between two runs a bug rather than a judgement call.
 *
 * No money moves here and no payment provider is called. The v1 catalog
 * declares no overage rates, so a v1 invoice is exactly one subscription
 * line; the overage arithmetic is exercised by tests so pricing can be
 * turned on later without reworking this module.
 */

import { BILLING_ENGINE_VERSION, type InvoiceDraft, type InvoiceLine, type PlanDefinition } from "./types.js";
import type { UsageSummary } from "./metering.js";

function centsFor(quantity: number, unitCents: number): number {
  // Integer cents throughout: no float ever touches a chargeable amount.
  return Math.round(quantity * unitCents);
}

export function computeInvoice(plan: PlanDefinition, usage: UsageSummary): InvoiceDraft {
  const lines: InvoiceLine[] = [];

  if (plan.priceCents > 0) {
    lines.push({
      kind: "SUBSCRIPTION",
      description: `${plan.name} plan (${plan.interval.toLowerCase()})`,
      dimension: null,
      quantity: 1,
      unitCents: plan.priceCents,
      amountCents: plan.priceCents
    });
  }

  for (const summary of usage.dimensions) {
    const unitCents = plan.overageCents[summary.dimension];
    if (unitCents === undefined || unitCents <= 0) continue;
    if (summary.overageUnits <= 0) continue;
    lines.push({
      kind: "OVERAGE",
      description: `${summary.dimension} overage`,
      dimension: summary.dimension,
      quantity: summary.overageUnits,
      unitCents,
      amountCents: centsFor(summary.overageUnits, unitCents)
    });
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);

  return {
    planCode: plan.code,
    currency: plan.currency,
    periodStart: usage.period.start,
    periodEnd: usage.period.end,
    lines,
    subtotalCents,
    // No tax engine and no discounts in v1: total is the subtotal, and the
    // field exists so adding either is not a schema change.
    totalCents: subtotalCents,
    engineVersion: BILLING_ENGINE_VERSION
  };
}
