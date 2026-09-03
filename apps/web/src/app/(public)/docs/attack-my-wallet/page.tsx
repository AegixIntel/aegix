import { DocHeading, DocSection, DocList, DocCode, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Attack My Wallet" };

export default function AttackMyWalletDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Product" title="Attack My Wallet" lead="Simulated paths an observer could follow through public data." />

      <DocSection title="Path structure">
        <DocCode>{`TARGET
  ↓
FUNDING
  ↓
RELATED WALLET
  ↓
ENTITY
  ↓
OBSERVABLE LINKABILITY`}</DocCode>
      </DocSection>

      <DocSection title="Observed vs inferred">
        <p>Attack paths combine <strong>observed</strong> edges (direct, verifiable relationships) with <strong>inferred</strong> edges (correlation hypotheses). The UI distinguishes them with visual styling and labels so you always know what is direct evidence versus a hypothesis.</p>
      </DocSection>

      <DocSection title="Bounded scope">
        <DocList items={[
          "The graph is bounded by backend limits — it never renders hundreds of nodes.",
          "Each path carries a path score, confidence, evidence, source engine, and engine version.",
          "A mobile list/table fallback is available where a visual graph is impractical."
        ]} />
      </DocSection>

      <DocNote>
        AEGIX simulates paths an observer could follow. It does not claim real-world identification.
      </DocNote>
    </div>
  );
}
