import Image from "next/image";
import Link from "next/link";
import { SectionLabel, EditorialHeading, StatusBadge, InlineArrowLink } from "@/components/ui/primitives";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Market Intelligence",
  description: "AEGIX market intelligence — Narrative Radar, Anomaly Detection, Cross-Market Intelligence and Signal Engine. In development."
};

const DIRECTIONS = [
  { t: "Narrative Radar", b: "Detect emerging narratives and sentiment shifts in on-chain and market data." },
  { t: "Anomaly Detection", b: "Surface unusual patterns that deviate from expected market behavior." },
  { t: "Cross-Market Intelligence", b: "Find signals that connect markets, protocols, and assets." },
  { t: "Signal Engine", b: "A deterministic engine for turning noisy data into structured market signals." }
];

export default function MarketsPage() {
  return (
    <div className="pb-24">
      <div className="container-page py-20 md:py-28">
        <div className="max-w-3xl">
          <SectionLabel status="IN DEVELOPMENT">Market Intelligence</SectionLabel>
          <EditorialHeading as="h1" className="mt-6">
            Markets beyond the surface.
          </EditorialHeading>
          <p className="mt-6 editorial-body">
            AEGIX is expanding from on-chain privacy into market intelligence — detecting narratives, anomalies,
            and emerging signals before they become consensus.
          </p>
        </div>

        <div className="mt-12 grid gap-x-12 gap-y-0 md:grid-cols-2">
          {DIRECTIONS.map((d, i) => (
            <div key={d.t} className="border-t border-white/10 py-6">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-muted-2">{String(i + 1).padStart(2, "0")}</span>
                <h2 className="font-display text-xl font-semibold text-marble">{d.t}</h2>
                <StatusBadge label="In Development" className="ml-auto" />
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{d.b}</p>
            </div>
          ))}
        </div>

        <div className="mt-16">
          <div className="aspect-video overflow-hidden rounded-lg border border-white/10 opacity-80">
            <Image
              src="/assets/aegix-market-structure.jpg"
              alt="AEGIX market structure concept — aspirational research direction, in development"
              width={1280}
              height={720}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
            Market intelligence — in development, not yet live
          </p>
        </div>

        <div className="mt-16">
          <InlineArrowLink href="/roadmap">Explore the roadmap</InlineArrowLink>
          <span className="mx-3 text-muted-2">·</span>
          <Link href="/privacy" className="text-sm text-muted-foreground hover:text-marble">
            See what&apos;s live now →
          </Link>
        </div>
      </div>
    </div>
  );
}
