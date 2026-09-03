import Link from "next/link";
import { SectionLabel, EditorialHeading, PipelineDiagram, StatusBadge } from "@/components/ui/primitives";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How AEGIX converts public on-chain data into evidence-based intelligence, with confidence and limitations made explicit."
};

const CONTROLS = [
  { name: "Common hub penalty", detail: "Shared popular hubs contribute less evidence than rare, distinctive relationships." },
  { name: "Common entity penalty", detail: "Interactions with widely-used entities are discounted as non-distinctive." },
  { name: "Population commonality", detail: "Overlap is weighted against the AEGIX-observed population, not the whole network." },
  { name: "Dust filtering", detail: "Negligible transfers are excluded so routine noise cannot inflate resemblance." },
  { name: "Sample adequacy", detail: "Results carry lower confidence when there are too few transactions to reason about." },
  { name: "Single-family caps", detail: "No single evidence family can dominate a conclusion." }
];

export default function MethodologyPage() {
  return (
    <div className="pb-24">
      <div className="container-narrow py-20 md:py-28">
        <SectionLabel>Methodology</SectionLabel>
        <EditorialHeading as="h1" className="mt-6">
          Intelligence without
          <br />
          unsupported certainty.
        </EditorialHeading>
        <p className="mt-8 editorial-body">
          AEGIX is deterministic and evidence-backed. It converts observable public activity into structured
          intelligence, while making clear where evidence is weak or the picture is incomplete.
        </p>
      </div>

      <div className="container-page py-16">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionLabel>Pipeline</SectionLabel>
            <EditorialHeading className="mt-6">From signal to exposure.</EditorialHeading>
            <p className="mt-6 editorial-body">
              Each stage is versioned and inspectable. Confidence is never a guess — it reflects data quality,
              sample adequacy, and semantic coverage.
            </p>
          </div>
          <div className="border border-white/10 p-8">
            <PipelineDiagram
              steps={["Signal", "Evidence", "Relationship", "Correlation", "Confidence", "Exposure"]}
            />
          </div>
        </div>
      </div>

      <div className="container-narrow py-16">
        <div className="border-t border-white/10 pt-16 text-center">
          <h2 className="statement">
            Correlation <span className="text-accent-bright">≠</span> Ownership{" "}
            <span className="text-accent-bright">≠</span> Identity
          </h2>
          <p className="mx-auto mt-8 max-w-md text-muted-foreground">
            AEGIX reports observable relationships. It does not identify the person behind a wallet, and
            correlation is never proof of ownership.
          </p>
        </div>
      </div>

      <div className="container-page py-16">
        <div className="max-w-2xl">
          <SectionLabel>Strength vs Confidence</SectionLabel>
          <div className="mt-6 grid gap-8 md:grid-cols-2">
            <div className="border-t border-white/10 pt-6">
              <StatusBadge label="Strength" />
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                How strong are the observed relationship signals.
              </p>
            </div>
            <div className="border-t border-white/10 pt-6">
              <StatusBadge label="Confidence" />
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                How reliable the available evidence is.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="container-page py-16">
        <div className="max-w-2xl">
          <SectionLabel>Commonality</SectionLabel>
          <h2 className="mt-6 font-display text-2xl font-semibold text-marble">
            AEGIX observed population <span className="text-accent-bright">≠</span> global Solana
          </h2>
          <p className="mt-4 text-muted-foreground">
            Population Commonality measures observations inside AEGIX&apos;s eligible dataset, subject to
            freshness and sample requirements. It never implies global chain frequency unless the backend
            genuinely measures it.
          </p>
        </div>
      </div>

      <div className="container-page py-16">
        <div className="max-w-2xl">
          <SectionLabel>Guarding against false positives</SectionLabel>
          <div className="mt-6 space-y-0">
            {CONTROLS.map((c) => (
              <div key={c.name} className="border-t border-white/10 py-5">
                <h3 className="font-display text-lg font-semibold text-marble">{c.name}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="container-narrow py-8 text-center">
        <Link href="/privacy" className="btn-primary">
          Explore live intelligence
        </Link>
        <Link href="/docs" className="btn-secondary ml-3">
          Read the docs
        </Link>
      </div>
    </div>
  );
}
