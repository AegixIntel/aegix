import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Correlation" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Correlation" lead="Cross-wallet similarity across evidence families." />
      <DocSection title="Overview">
        <p>Correlation aggregates similarity across multiple independent evidence families, weighted by population commonality. Correlation indicates observable linkability — it never establishes common ownership or identity.</p>
      </DocSection>
    </div>
  );
}
