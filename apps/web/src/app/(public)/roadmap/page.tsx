import Link from "next/link";
import { SectionLabel, EditorialHeading, StatusBadge } from "@/components/ui/primitives";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "AEGIX status-driven roadmap — shipped, current, next and later direction."
};

const GROUPS = [
  { label: "SHIPPED", items: ["Intelligence Core", "Wallet X-Ray", "Attack My Wallet", "Compare Intelligence", "Privacy Monitor", "Developer Intelligence API"] },
  { label: "CURRENT", items: ["Public Product Launch", "Multi-User Production", "Documentation", "Infrastructure Hardening"] },
  { label: "NEXT", items: ["Market Intelligence", "Narrative Radar", "Anomaly Detection", "Signal Engine"] },
  { label: "LATER", items: ["AI Intelligence Copilot", "Wallet Reputation", "Intelligence Network", "$AEX Economic Layer", "Multi-Chain"] }
];

export default function RoadmapPage() {
  return (
    <div className="container-page py-20 md:py-28">
      <div className="max-w-3xl">
        <SectionLabel>Roadmap</SectionLabel>
        <EditorialHeading as="h1" className="mt-6">
          Status-driven, not date-driven.
        </EditorialHeading>
        <p className="mt-6 editorial-body">
          AEGIX has shipped an intelligence core. What follows is grounded in the real repository state — not an
          aspirational timeline.
        </p>
      </div>

      <div className="mt-14 space-y-0">
        {GROUPS.map((g) => (
          <div key={g.label} className="grid gap-6 border-t border-white/10 py-10 md:grid-cols-[12rem_1fr]">
            <div>
              <StatusBadge label={g.label} />
            </div>
            <ul className="grid gap-x-10 gap-y-2 sm:grid-cols-2">
              {g.items.map((i) => (
                <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="h-1 w-1 rounded-full bg-muted-2" aria-hidden="true" />
                  {i}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-16 border-t border-white/10 pt-10">
        <p className="max-w-2xl text-sm text-muted-2">
          Planned capabilities are shown for direction only and are not yet operational. See what&apos;s live
          today in privacy intelligence.{" "}
          <Link href="/privacy" className="text-marble underline underline-offset-4">
            View live products →
          </Link>
        </p>
      </div>
    </div>
  );
}
