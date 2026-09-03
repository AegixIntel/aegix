import Link from "next/link";
import { SectionLabel, EditorialHeading, PipelineDiagram, InlineArrowLink } from "@/components/ui/primitives";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Intelligence",
  description: "AEGIX intelligence primitives — funding, counterparties, entities, behavior, temporal activity, relationships and commonality."
};

const PRIMITIVES = [
  { key: "funding", title: "Funding", body: "Traces observable funding provenance while filtering dust and low-quality relationships. Engines: funding provenance." },
  { key: "behavior", title: "Behavioral", body: "Compares behavioral fingerprints to detect resemblance between wallets. Engines: behavioral similarity." },
  { key: "temporal", title: "Temporal", body: "Looks for meaningful co-occurrence in transaction timing. Engines: temporal correlation." },
  { key: "entities", title: "Entities", body: "Binds activity to known entities from a verified registry. Engines: entity intelligence." },
  { key: "commonality", title: "Commonality", body: "Weights overlap against the AEGIX-observed population. Engines: population commonality." }
];

export default function IntelligencePage() {
  return (
    <div className="pb-24">
      <div className="container-page py-20 md:py-28">
        <div className="max-w-3xl">
          <SectionLabel>Intelligence</SectionLabel>
          <EditorialHeading as="h1" className="mt-6">
            Public activity becomes observable intelligence.
          </EditorialHeading>
          <p className="mt-6 editorial-body">
            AEGIX composes every result from a small set of deterministic primitives — each a real engine,
            each traceable to evidence.
          </p>
        </div>

        <div className="mt-12 grid gap-x-12 gap-y-0 md:grid-cols-2 lg:grid-cols-3">
          {PRIMITIVES.map((p) => (
            <div key={p.key} id={p.key} className="scroll-mt-16 border-t border-white/10 py-6">
              <h2 className="font-display text-xl font-semibold text-marble">{p.title}</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
          <div className="border-t border-white/10 py-6">
            <h2 className="font-display text-xl font-semibold text-marble">Relationships &amp; Correlation</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Builds a bounded graph of observed and inferred edges, then rates correlation strength separately
              from confidence.
            </p>
          </div>
        </div>
      </div>

      <div className="container-page border-t border-white/10 pt-16">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionLabel>Pipeline</SectionLabel>
            <EditorialHeading className="mt-6">From activity to exposure.</EditorialHeading>
          </div>
          <div className="border border-white/10 p-8">
            <PipelineDiagram
              steps={["Public Activity", "Normalization", "Signals", "Relationships", "Correlation", "Confidence", "Exposure"]}
            />
          </div>
        </div>
      </div>

      <div className="container-page mt-16">
        <Link href="/methodology" className="btn-secondary">
          Read the methodology
        </Link>
      </div>
    </div>
  );
}
