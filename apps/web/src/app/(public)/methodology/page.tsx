import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How AEGIX converts on-chain data into evidence-based privacy intelligence, with confidence and limitations made explicit."
};

const pipeline = [
  { label: "Raw Activity", detail: "Public Solana transactions and account state collected from RPC providers." },
  { label: "Normalization", detail: "Transactions parsed into structured, versioned records; unknown programs accounted for." },
  { label: "Signals", detail: "Deterministic event detection — funding, counterparties, entities, behavior, timing." },
  { label: "Evidence", detail: "Each signal carries concrete inspectable evidence (matches, timestamps, deltas, references)." },
  { label: "Correlation", detail: "Cross-wallet similarity across evidence families, weighted by population commonality." },
  { label: "Confidence", detail: "How reliable the underlying data is — separate from how strong a signal is." },
  { label: "Exposure", detail: "A composite privacy exposure score with per-dimension breakdown." }
];

const controls = [
  { name: "Common hub penalty", detail: "Shared popular hubs contribute less evidence than rare, distinctive relationships." },
  { name: "Common entity penalty", detail: "Interactions with widely-used entities are discounted as non-distinctive." },
  { name: "Population commonality", detail: "Overlap is weighted against the AEGIX-observed population, not the whole network." },
  { name: "Dust filtering", detail: "Negligible transfers are excluded so routine noise cannot inflate resemblance." },
  { name: "Sample adequacy", detail: "Results carry lower confidence when there are too few transactions to reason about." },
  { name: "Semantic coverage", detail: "The share of activity that could actually be understood is reported explicitly." },
  { name: "Single-family caps", detail: "No single evidence family can dominate a conclusion; strength must come from multiple views." }
];

export default function MethodologyPage() {
  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-3xl text-center">
        <p className="marketing-eyebrow">Methodology</p>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-marble md:text-6xl">
          From on-chain data to exposure.
        </h1>
        <p className="marketing-body mt-6">
          AEGIX is deterministic and evidence-backed. It converts observable public activity into structured
          intelligence, while making clear where evidence is weak or the picture is incomplete.
        </p>
      </div>

      {/* Pipeline */}
      <section className="mt-16">
        <h2 className="marketing-h2 text-center">The pipeline</h2>
        <ol className="mx-auto mt-10 max-w-2xl space-y-3">
          {pipeline.map((step, i) => (
            <li key={step.label} className="card-surface flex items-start gap-4 p-5">
              <span className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent/20 text-sm font-semibold text-accent-bright">
                {i + 1}
              </span>
              <div>
                <h3 className="font-display text-lg font-semibold text-marble">{step.label}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Strength vs confidence */}
      <section className="mt-16 grid gap-6 md:grid-cols-2">
        <div className="card-surface p-6">
          <h2 className="font-display text-xl font-semibold text-marble">Correlation Strength</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            How strong are the observed relationship signals? Strength describes the magnitude of resemblance
            AEGIX detected between wallets across evidence families.
          </p>
        </div>
        <div className="card-surface p-6">
          <h2 className="font-display text-xl font-semibold text-marble">Confidence</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            How reliable is the available evidence? Confidence reflects data quality, sample adequacy, and
            semantic coverage — a high-strength signal built on thin data is reported with low confidence.
          </p>
        </div>
      </section>

      {/* False positive controls */}
      <section className="mt-16">
        <h2 className="marketing-h2 text-center">Guarding against false positives</h2>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {controls.map((c) => (
            <div key={c.name} className="card-surface p-5">
              <h3 className="font-semibold text-marble">{c.name}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Epistemic limit */}
      <section className="mt-16 rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
        <h2 className="font-display text-2xl font-semibold text-marble">A clear epistemic limit</h2>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          AEGIX surfaces observable linkability between public wallets. It does not identify the person behind
          a wallet, and correlation is never proof of ownership. The AEGIX-observed population is not the
          global Solana population.
        </p>
        <p className="mt-6 text-center font-display text-lg font-semibold text-marble/90">
          Correlation <span className="text-accent-bright">≠</span> Ownership{" "}
          <span className="text-accent-bright">≠</span> Identity
        </p>
      </section>

      <div className="mt-12 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
        <Link href="/app/analyze" className="btn-primary">Analyze a wallet</Link>
        <Link href="/docs" className="btn-secondary">Read the docs</Link>
      </div>
    </div>
  );
}
