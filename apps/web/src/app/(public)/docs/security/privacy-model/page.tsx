import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Model" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Security" title="Privacy Model" lead="What AEGIX observes, and what it never claims." />
      <DocSection title="Observable data only">
        <p>AEGIX analyzes a wallet's public on-chain activity. It does not access private keys, private data, or off-chain personal information.</p>
      </DocSection>
      <DocSection title="Epistemic limits">
        <p>AEGIX reports observable linkability. It never identifies the person behind a wallet, and correlation is never proof of ownership. The AEGIX observed population is not the global Solana population.</p>
      </DocSection>
    </div>
  );
}
