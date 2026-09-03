import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Relationship Graph" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Relationship Graph" lead="Bounded graph of observable relationships." />
      <DocSection title="Overview">
        <p>The relationship graph surfaces paths and edges between wallets, with each edge carrying evidence, confidence, and observation class (observed vs inferred).</p>
      </DocSection>
    </div>
  );
}
