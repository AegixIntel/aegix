import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Funding Provenance" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Funding Provenance" lead="Understanding where a wallet's funds came from." />
      <DocSection title="What it detects">
        <p>Funding provenance traces observable funding sources — direct transfers, exchanges, and chained funding paths — that contribute to a wallet's linkability and exposure.</p>
      </DocSection>
      <DocSection title="Evidence">
        <p>Detected funding paths carry concrete evidence: transfers, timestamps, and the wallets/entities involved. Correlation is reported as observable relationship, never as ownership.</p>
      </DocSection>
    </div>
  );
}
