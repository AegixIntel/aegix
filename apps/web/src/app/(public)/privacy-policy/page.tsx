import Link from "next/link";
import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal-document";
import { LEGAL_EFFECTIVE_DATE, LEGAL_ENTITY } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What personal data AEGIX processes, why, who it is shared with, and the choices you have."
};

export default function PrivacyPolicyPage() {
  return (
    <LegalDocument
      label="Legal"
      title="Privacy Policy"
      effectiveDate={LEGAL_EFFECTIVE_DATE}
      intro={
        <>
          This policy explains what personal data {LEGAL_ENTITY} (&ldquo;we&rdquo;) processes when you use AEGIX, why, and
          the choices you have. AEGIX is built to need very little: you sign in with a wallet, and we do not ask for your
          name, email address or phone number.
        </>
      }
      sections={[
        {
          title: "1. What we collect",
          body: (
            <>
              <ul>
                <li>
                  <strong className="text-ink">Account.</strong> The wallet address you sign in with, and your signed-in
                  session. The session token is kept in your browser&apos;s local storage and expires after seven days.
                </li>
                <li>
                  <strong className="text-ink">What you save.</strong> Saved analyses, saved comparisons, privacy
                  monitors and their alert settings, and the notifications they produce.
                </li>
                <li>
                  <strong className="text-ink">Developer features.</strong> API keys, webhook endpoints you register,
                  and records of your API usage. Webhook signing secrets are stored encrypted.
                </li>
                <li>
                  <strong className="text-ink">Billing.</strong> Your plan, subscription history, invoices and usage
                  counts. If you request an upgrade, the plan you asked for and any contact detail you choose to give us,
                  such as an email address or Telegram handle.
                </li>
                <li>
                  <strong className="text-ink">Technical data.</strong> The IP address of analysis requests, used to
                  apply rate limits and prevent abuse, and server logs with request metadata. Our logs are designed not
                  to record full wallet addresses, keys or secrets.
                </li>
              </ul>
            </>
          )
        },
        {
          title: "2. Public blockchain data",
          body: (
            <>
              <p>
                AEGIX analyses public Solana data. The wallets you analyse, compare or monitor are public, and an analysis
                computed from public data may be reused when anyone else analyses the same wallet. We do not link wallets
                to real-world identities, and our results never assert who owns a wallet.
              </p>
            </>
          )
        },
        {
          title: "3. How we use it",
          body: (
            <>
              <p>
                To provide the Service; to apply the limits of your plan; to keep the Service secure and prevent abuse;
                and, when you request an upgrade, to contact you about it. We do not sell personal data, show advertising,
                or use third-party analytics or tracking scripts.
              </p>
            </>
          )
        },
        {
          title: "4. Who we share it with",
          body: (
            <>
              <p>We use a small number of service providers to run AEGIX:</p>
              <ul>
                <li>hosting and infrastructure providers that store and process the data above on our behalf;</li>
                <li>Solana RPC providers, which receive the wallet addresses being analysed;</li>
                <li>a market data provider, which receives no personal data;</li>
                <li>
                  an AI model provider for Ask AEGIX: when you ask a question, the question and a bounded summary of public
                  on-chain evidence about that wallet are sent to generate the answer. Your contact details are never
                  included.
                </li>
              </ul>
              <p>We may also disclose data where the law requires it.</p>
            </>
          )
        },
        {
          title: "5. How long we keep it",
          body: (
            <>
              <p>
                We keep your data while your account is in use. Ending a paid plan does not delete it. You can delete
                saved analyses, saved comparisons, monitors, API keys and webhook endpoints yourself at any time from the
                app. To have your account and the data associated with it deleted, contact us.
              </p>
            </>
          )
        },
        {
          title: "6. Your rights",
          body: (
            <>
              <p>
                Subject to applicable law, including Indonesia&apos;s Personal Data Protection Law (Law No. 27 of 2022), you
                can ask to access, correct or delete your personal data, or object to how we process it.
              </p>
            </>
          )
        },
        {
          title: "7. Security",
          body: (
            <>
              <p>
                We use encrypted connections, encrypt webhook signing secrets, keep databases private, and limit access to
                production systems. No system is perfectly secure; if a breach affects your data we will notify you as the
                law requires.
              </p>
            </>
          )
        },
        {
          title: "8. Children",
          body: (
            <>
              <p>AEGIX is not intended for anyone under 18.</p>
            </>
          )
        },
        {
          title: "9. Changes",
          body: (
            <>
              <p>
                We may update this policy; the effective date above shows when it last changed. See also our{" "}
                <Link href="/terms">Terms of Service</Link>.
              </p>
            </>
          )
        }
      ]}
    />
  );
}
