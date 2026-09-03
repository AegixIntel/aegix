import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Semantic Coverage" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Semantic Coverage" lead="The share of activity AEGIX could actually understand." />
      <DocSection title="Overview">
        <p>Semantic coverage reports how much of a wallet's activity was meaningfully parsed versus left generic. Unknown or opaque programs are counted honestly rather than silently treated as understood.</p>
      </DocSection>
    </div>
  );
}
