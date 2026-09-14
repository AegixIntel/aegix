import Link from "next/link";
import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal-document";
import { LEGAL_EFFECTIVE_DATE, LEGAL_ENTITY } from "@/lib/site";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "How payment, cancellation and refunds work for AEGIX paid plans."
};

export default function RefundPage() {
  return (
    <LegalDocument
      label="Legal"
      title="Refund Policy"
      effectiveDate={LEGAL_EFFECTIVE_DATE}
      intro={
        <>
          This policy explains how payment, cancellation and refunds work for AEGIX paid plans, operated by{" "}
          {LEGAL_ENTITY}. It forms part of our <Link href="/terms">Terms of Service</Link>.
        </>
      }
      sections={[
        {
          title: "Payments are non-refundable",
          body: (
            <>
              <p>
                Payments for Pro and Team plans are not refundable. This includes partially used periods, unused quota,
                and moving to a lower plan or back to Free.
              </p>
              <p>
                Try the Free plan first: it uses the same analysis engine, with lower limits, so you can judge whether a
                paid plan is right for you before paying.
              </p>
            </>
          )
        },
        {
          title: "Cancel at any time",
          body: (
            <>
              <p>
                You can cancel from your <Link href="/app/billing">Plan &amp; usage</Link> page whenever you like. Your paid
                plan stays active until the end of the period you have already paid for; after that your account returns to
                the Free plan and no further payment is requested.
              </p>
              <p>Cancelling never deletes your saved analyses, comparisons, monitors or profile.</p>
            </>
          )
        },
        {
          title: "No automatic charges",
          body: (
            <>
              <p>
                Paid plans are currently provisioned manually. We never charge a card or wallet automatically; each
                payment is arranged with you before a plan is activated or continued.
              </p>
            </>
          )
        },
        {
          title: "Billing mistakes and your legal rights",
          body: (
            <>
              <p>
                If you are charged twice or charged an amount that differs from the one agreed, tell us and we will
                correct it. Nothing in this policy limits any refund right that applicable law gives you and that cannot
                be excluded by agreement.
              </p>
            </>
          )
        }
      ]}
    />
  );
}
