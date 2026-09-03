import Link from "next/link";
import { DocHeading, DocSection, DocList } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Wallet X-Ray" };

export default function WalletXRayDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Product" title="Wallet X-Ray" lead="An evidence-based privacy exposure report for a single Solana wallet." />

      <DocSection title="What it shows">
        <DocList items={[
          "Privacy Exposure Score (0–100) with severity band",
          "Analysis Confidence — how reliable the available data is",
          "Data Quality grade + semantic coverage",
          "Seven exposure dimensions",
          "Top signals, each with concrete inspectable evidence",
          "Attack My Wallet paths",
          "Potential wallet correlations (when enabled)",
          "Engine versions and limitations"
        ]} />
      </DocSection>

      <DocSection title="Seven dimensions">
        <DocList items={[
          "Identity Linkability",
          "Funding Exposure",
          "Exchange / Entity Exposure",
          "Wallet Cluster Exposure",
          "Behavioral Fingerprint",
          "Counterparty Exposure",
          "Transaction Pattern Exposure"
        ]} />
      </DocSection>

      <DocSection title="Score vs confidence">
        <p>Exposure score and confidence are distinct. A high score built on sparse data is reported with low confidence — the UI keeps them separate so you are never misled.</p>
        <p className="mt-3">
          <Link href="/docs/exposure-score" className="text-accent underline">Read about the exposure score →</Link>
        </p>
      </DocSection>
    </div>
  );
}
