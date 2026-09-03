import { DocHeading, DocSection } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Entity Intelligence" };

export default function Page() {
  return (
    <div>
      <DocHeading eyebrow="Intelligence" title="Entity Intelligence" lead="Known entities a wallet interacts with." />
      <DocSection title="Overview">
        <p>AEGIX maps wallets to known entities (exchanges, protocols) from a verified knowledge base. Entity exposures carry provenance, verification status, and confidence.</p>
      </DocSection>
    </div>
  );
}
