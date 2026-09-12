import Link from "next/link";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "Markets Intelligence", description: "BTC, ETH and SOL market observations with deterministic signals and bounded history." };
export default function MarketsPage() {
  return <main className="container-page py-20">
    <h1 className="font-display text-3xl text-marble">Markets Intelligence</h1>
    <p className="mt-6 max-w-2xl text-muted-foreground">BTC, ETH and SOL price, volume, bounded hourly history, freshness and deterministic signals. Anomaly does not establish manipulation. Temporal correlation does not establish causation.</p>
    <Link href="/app/markets" className="btn-primary mt-8 inline-block px-5 py-3">Open Markets</Link>
  </main>;
}
