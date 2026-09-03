import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Temporal Correlation" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Temporal Correlation" lead="Timing patterns across wallets." />
      <DocSection title="Overview">
        <p>Temporal correlation looks for meaningful co-occurrence in transaction timing. It is one evidence family among many and never stands alone as proof of relationship.</p>
      </DocSection>
    </div>
  );
}
