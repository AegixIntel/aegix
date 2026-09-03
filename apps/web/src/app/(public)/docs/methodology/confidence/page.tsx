import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Confidence" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Confidence" lead="How reliable the available evidence is — separate from strength." />
      <DocSection title="Overview">
        <p>Confidence reflects data quality, sample adequacy, and semantic coverage. It answers &quot;how reliable is the available evidence?&quot; and is never conflated with correlation strength.</p>
      </DocSection>
    </div>
  );
}
