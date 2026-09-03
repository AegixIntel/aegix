import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Signals" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Signals" lead="Deterministic events derived from normalized on-chain data." />
      <DocSection title="Overview">
        <p>Signals are deterministic detections — funding, counterparties, entities, behavior, and timing — produced by versioned engines from normalized transaction data. Each signal carries severity, confidence, and evidence.</p>
      </DocSection>
    </div>
  );
}
