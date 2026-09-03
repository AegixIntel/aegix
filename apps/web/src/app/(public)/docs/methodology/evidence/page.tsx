import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Evidence" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Evidence" lead="Concrete, inspectable data behind every signal." />
      <DocSection title="Overview">
        <p>Every meaningful result references inspectable evidence — matched signatures, timestamps, deltas, and transaction references — rather than returning only a score. Evidence provenance is preserved end-to-end.</p>
      </DocSection>
    </div>
  );
}
