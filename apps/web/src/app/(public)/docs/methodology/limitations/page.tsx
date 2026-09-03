import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Limitations" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Limitations" lead="Where the evidence is weak or the picture is incomplete." />
      <DocSection title="Overview">
        <p>AEGIX exposes limitations with the same prominence as supporting evidence. Counter-evidence and misleading possibilities are shown next to reasons for a relationship, so conclusions are never confirmation-biased.</p>
      </DocSection>
    </div>
  );
}
