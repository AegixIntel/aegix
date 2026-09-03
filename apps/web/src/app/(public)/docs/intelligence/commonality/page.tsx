import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Population Commonality" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Population Commonality" lead="Weighting overlap by how common it is." />
      <DocSection title="Overview">
        <p>Population commonality discounts counterparties and entities that are widespread across the AEGIX observed population, so rare overlap contributes more evidence than common overlap.</p>
      </DocSection>
    </div>
  );
}
