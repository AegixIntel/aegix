import { DocHeading, DocSection, DocList, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Wallet Authentication" };

export default function AuthDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Getting Started" title="Wallet Authentication" lead="Sign a challenge with your Solana wallet. No transaction, no SOL." />

      <DocSection title="How it works">
        <ol className="list-decimal space-y-2 pl-4">
          <li>You connect a compatible Solana wallet.</li>
          <li>AEGIX returns a domain-bound challenge message with a nonce.</li>
          <li>You sign the exact message with <code className="font-mono">wallet.signMessage</code>.</li>
          <li>AEGIX verifies the signature and issues a session token.</li>
        </ol>
      </DocSection>

      <DocSection title="The message">
        <DocCode>{`AEGIX wants you to sign in with your Solana wallet.

Wallet: <YOUR_PUBLIC_KEY>
Domain: aegixintelligence.com
Nonce: <random>
Issued: <ISO timestamp>
Version: 1`}</DocCode>
      </DocSection>

      <DocSection title="Why it is safe">
        <DocList items={[
          "Signing does not create a blockchain transaction.",
          "Signing costs no SOL.",
          "AEGIX never sees your private keys or seed phrase.",
          "Challenges are domain-bound and time-limited, preventing replay.",
          "Switching wallets invalidates the previous session."
        ]} />
      </DocSection>

      <DocSection title="Wallet support">
        <p>Compatible Solana wallets — including Phantom and Solflare — are supported through the standard wallet-adapter architecture. AEGIX does not hard-code to any single vendor.</p>
      </DocSection>

      <DocNote>
        The notification email is a delivery destination only and is <strong>not</strong> a login credential.
      </DocNote>
    </div>
  );
}
