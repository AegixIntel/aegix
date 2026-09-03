import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Behavioral Similarity" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Behavioral Similarity" lead="How similar two wallets' observable behavior is." />
      <DocSection title="Overview">
        <p>AEGIX compares behavioral fingerprints across wallets, weighting distinctive patterns more heavily than common ones. Behavior is reported as observable similarity, not identity.</p>
      </DocSection>
    </div>
  );
}
