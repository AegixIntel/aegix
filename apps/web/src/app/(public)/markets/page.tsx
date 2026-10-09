import Link from "next/link";
import { StatusBadge } from "@/components/ui/primitives";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "Markets Intelligence", description: "BTC, ETH and SOL market observations with deterministic signals and bounded history." };
export default function MarketsPage() {
  return <main className="container-page py-20">
    <div className="flex items-center gap-3">
      <h1 className="font-display text-3xl text-ink">Markets Intelligence</h1>
      <StatusBadge label="LIVE" />
    </div>
    <p className="mt-6 max-w-2xl text-muted-foreground">BTC, ETH and SOL price, volume, bounded hourly history, freshness and deterministic signals. Anomaly does not establish manipulation. Temporal correlation does not establish causation.</p>
    <p className="mt-4 max-w-2xl font-mono text-[11px] uppercase tracking-[0.14em] text-muted-2">Three assets · bounded hourly window · deterministic signals only</p>
    <p className="mt-6 max-w-2xl text-sm text-muted-2">This page is price and volume for three assets. Narrative, cross-market and fund analysis are separate products — see <Link href="/roadmap" className="text-ink underline underline-offset-4">the roadmap</Link>.</p>
    <Link href="/app/markets" className="btn-primary mt-8 inline-block px-5 py-3">Open Markets</Link>
  </main>;
}
