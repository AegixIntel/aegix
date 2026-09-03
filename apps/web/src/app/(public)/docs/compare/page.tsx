import { DocHeading, DocSection, DocList, DocNote } from "@/components/docs/article";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Compare Wallets" };

export default function CompareDocPage() {
  return (
    <div>
      <DocHeading eyebrow="Product" title="Compare Wallets" lead="Cross-wallet correlation with strength and confidence reported separately." />

      <DocSection title="Evidence families">
        <DocList items={[
          "Funding — shared or chained funding sources",
          "Transfers — direct transfer relationships",
          "Counterparties — overlap in interacted wallets",
          "Entities — overlap in known entities",
          "Behavior — behavioral similarity",
          "Protocol Sequences — similar protocol sequences",
          "Temporal Correlation — timing patterns"
        ]} />
      </DocSection>

      <DocSection title="Correlation strength vs confidence">
        <p><strong>Correlation strength</strong> answers "how strong are the observed relationship signals?" <strong>Confidence</strong> answers "how reliable is the available evidence?" AEGIX keeps them separate and never conflates them.</p>
      </DocSection>

      <DocSection title="Population commonality">
        <p>Shared counterparties and entities carry less correlation weight when they are common across the AEGIX-observed population. Overlap is always reported against the AEGIX observed population, never the whole Solana network.</p>
      </DocSection>

      <DocSection title="Canonical pair">
        <p>A comparison of (A, B) is the same as (B, A). AEGIX uses a canonical pair identity so reverse comparisons reuse the same persisted result instead of duplicating expensive work.</p>
      </DocSection>

      <DocNote>
        Correlation indicates observable linkability. It does not establish common ownership or real-world identity.
      </DocNote>
    </div>
  );
}
