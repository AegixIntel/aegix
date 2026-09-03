import Link from "next/link";
import { SectionLabel, EditorialHeading } from "@/components/ui/primitives";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description: "AEGIX mission, philosophy and direction — financial & on-chain intelligence."
};

export default function AboutPage() {
  return (
    <div className="container-narrow py-20 md:py-28">
      <SectionLabel>About AEGIX</SectionLabel>
      <EditorialHeading as="h1" className="mt-6">
        Intelligence without unsupported certainty.
      </EditorialHeading>
      <div className="mt-10 space-y-5 text-lg leading-relaxed text-muted-foreground">
        <p>
          AEGIX is building an intelligence layer for understanding relationships, patterns, anomalies,
          correlations, and emerging signals inside public financial and on-chain data.
        </p>
        <p>
          Our current live intelligence is strongest in on-chain privacy. Market intelligence is in
          development. Everything we ship follows the same principle: structure over decoration, evidence over
          assertion.
        </p>
        <p>
          We start on Solana because it offers the throughput and low cost needed to surface real-time
          relationships across public activity.
        </p>
      </div>

      <div className="mt-16 border-t border-white/10 pt-10">
        <SectionLabel>Why public intelligence</SectionLabel>
        <p className="mt-4 text-muted-foreground">
          Public blockchains are a public record. AEGIX helps people understand what that record reveals about
          them — and helps developers build on top of that understanding. Correlation is not identity, and we
          say so everywhere.
        </p>
      </div>

      <div className="mt-10 border-t border-white/10 pt-10">
        <SectionLabel>Long-term direction</SectionLabel>
        <p className="mt-4 text-muted-foreground">
          Market intelligence, reputation infrastructure, and an intelligence network are on the horizon. They
          are labeled by status on the roadmap, never presented as live before they exist.{" "}
          <Link href="/roadmap" className="text-marble underline underline-offset-4">
            View the roadmap →
          </Link>
        </p>
      </div>
    </div>
  );
}
