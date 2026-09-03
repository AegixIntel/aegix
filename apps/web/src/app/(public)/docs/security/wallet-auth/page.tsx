import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Wallet Authentication" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Security" title="Wallet Authentication" lead="Sign a challenge, never a transaction." />
      <DocSection title="Overview">
        <p>AEGIX authenticates by asking you to sign a domain-bound challenge message with your Solana wallet. Signing costs no SOL and creates no transaction. Private keys never leave your wallet.</p>
      </DocSection>
      <DocSection title="Non-identity">
        <p>Wallet authentication ties a session to a public wallet identity — it is not used to identify a real person. The notification email is a delivery destination only.</p>
      </DocSection>
    </div>
  );
}
