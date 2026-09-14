import Link from "next/link";
import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal-document";
import { LEGAL_EFFECTIVE_DATE, LEGAL_ENTITY } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern use of AEGIX, its web application and developer API."
};

export default function TermsPage() {
  return (
    <LegalDocument
      label="Legal"
      title="Terms of Service"
      effectiveDate={LEGAL_EFFECTIVE_DATE}
      intro={
        <>
          These terms govern your use of AEGIX — the website, the web application and the developer API (together,
          the &ldquo;Service&rdquo;). AEGIX is operated by {LEGAL_ENTITY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By using
          the Service you agree to these terms.
        </>
      }
      sections={[
        {
          title: "1. What AEGIX is",
          body: (
            <>
              <p>
                AEGIX analyses public Solana blockchain data and reports observable relationships, privacy exposure,
                correlation and market context, together with the confidence and limitations of each result.
              </p>
              <p>
                AEGIX is non-custodial. We never hold funds or private keys, never ask for a seed phrase, and never
                execute transactions. We do not operate an exchange, brokerage or trading service.
              </p>
              <p>
                Results are probabilistic. Correlation is not proof of ownership, and AEGIX never asserts the real-world
                identity behind a wallet. Nothing in the Service is financial, investment, legal or tax advice.
              </p>
            </>
          )
        },
        {
          title: "2. Signing in",
          body: (
            <>
              <p>
                You sign in by signing a message with your Solana wallet. Signing costs nothing and authorises no
                transaction. Sessions expire automatically. You are responsible for the security of your wallet and of
                any device on which you stay signed in.
              </p>
            </>
          )
        },
        {
          title: "3. Acceptable use",
          body: (
            <>
              <p>You agree not to use the Service to:</p>
              <ul>
                <li>harass, stalk, threaten or unlawfully surveil any person, or attempt to identify individuals behind wallets for that purpose;</li>
                <li>break any law or regulation, including sanctions, anti-money-laundering and data protection law;</li>
                <li>circumvent quotas, rate limits, plan limits or security controls, or share accounts or API keys to do so;</li>
                <li>interfere with or overload the Service, or access it by automated means other than the developer API;</li>
                <li>resell or redistribute the Service or its output as your own product without our written permission.</li>
              </ul>
              <p>We may suspend or end access for use that breaks these terms.</p>
            </>
          )
        },
        {
          title: "4. Plans and payment",
          body: (
            <>
              <p>
                The Free plan costs nothing. Paid plans (Pro and Team) and their limits and prices are shown on your{" "}
                <Link href="/app/billing">Plan &amp; usage</Link> page.
              </p>
              <p>
                Paid plans are currently provisioned manually. You request an upgrade from Plan &amp; usage, we contact
                you to arrange payment, and the plan is activated once payment is confirmed. A request on its own does
                not activate a plan or create any obligation to pay.
              </p>
              <p>
                Paid plans run in monthly periods. We may change prices for future periods; a change never applies to a
                period you have already paid for. Payments are governed by our{" "}
                <Link href="/refund">Refund Policy</Link>.
              </p>
            </>
          )
        },
        {
          title: "5. Cancellation and end of a plan",
          body: (
            <>
              <p>
                You can cancel a paid plan at any time from Plan &amp; usage. It stays active until the end of the period
                you have paid for, then your account returns to the Free plan.
              </p>
              <p>
                Ending a paid plan does not delete your data. Saved analyses, comparisons, monitors and your profile are
                kept; monitors beyond the Free plan&apos;s limit are paused rather than removed.
              </p>
            </>
          )
        },
        {
          title: "6. Developer API and webhooks",
          body: (
            <>
              <p>
                API keys are confidential and tied to your account; you are responsible for activity made with them. Use
                is subject to the quotas of your plan. We may revoke keys or disable webhook endpoints that are abused,
                compromised or that repeatedly fail.
              </p>
            </>
          )
        },
        {
          title: "7. Availability and third-party data",
          body: (
            <>
              <p>
                The Service depends on third parties, including Solana RPC and market data providers, and on public
                blockchain data that may be incomplete or delayed. We work to keep the Service accurate and available but
                do not guarantee uninterrupted operation, and we may change, add or remove features.
              </p>
            </>
          )
        },
        {
          title: "8. Disclaimer and limitation of liability",
          body: (
            <>
              <p>
                The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent permitted by law, we
                disclaim all warranties, express or implied, and we are not liable for decisions you make based on the
                Service, or for indirect, incidental or consequential loss, including lost profits or lost funds.
              </p>
              <p>
                To the extent permitted by law, our total liability for any claim relating to the Service is limited to
                the amount you paid us for the Service in the three months before the claim arose.
              </p>
            </>
          )
        },
        {
          title: "9. Changes to these terms",
          body: (
            <>
              <p>
                We may update these terms. The effective date above shows when they last changed. Continuing to use the
                Service after a change means you accept the updated terms.
              </p>
            </>
          )
        },
        {
          title: "10. Governing law",
          body: (
            <>
              <p>
                These terms are governed by the laws of the Republic of Indonesia, without prejudice to any mandatory
                consumer protection that applies to you where you live.
              </p>
            </>
          )
        }
      ]}
    />
  );
}
