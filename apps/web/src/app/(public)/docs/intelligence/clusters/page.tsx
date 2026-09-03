import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Cluster Hypothesis" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Cluster Hypothesis" lead="Hypothetical clusters of related wallets." />
      <DocSection title="Overview">
        <p>Cluster hypotheses are bounded relationship groupings driven by multiple independent evidence families. They are hypotheses, never ownership claims.</p>
      </DocSection>
    </div>
  );
}
