import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Data Quality" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Methodology" title="Data Quality" lead="A grade on how much confidence the dataset supports." />
      <DocSection title="Overview">
        <p>Data quality measures history coverage, transaction coverage, parser success, RPC completeness, known-program ratio, and sample adequacy. It is reported separately from the exposure score.</p>
      </DocSection>
    </div>
  );
}
