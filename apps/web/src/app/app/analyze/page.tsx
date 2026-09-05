import AnalyzeForm from "@/components/analyze-form";
import { Reveal } from "@/components/motion/reveal";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet X-Ray",
  description: "Analyze a Solana wallet's public on-chain privacy exposure."
};

const ANALYSIS_STEPS = [
  { number: "01", title: "Observe", body: "Normalize public wallet activity into verifiable signals." },
  { number: "02", title: "Correlate", body: "Map funding, behavior, entities, and counterparties." },
  { number: "03", title: "Interpret", body: "Separate exposure, evidence strength, and confidence." }
];

export default function AnalyzePage() {
  return (
    <div className="analysis-workspace relative min-h-screen overflow-hidden">
      <div className="relative z-10 mx-auto w-full max-w-[86rem] px-5 py-8 md:px-10 md:py-12 lg:px-14 lg:py-16">
        <Reveal as="div" className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-2">
            <span>Intelligence</span>
            <span className="text-white/20">/</span>
            <span className="text-accent-bright">Wallet X-Ray</span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">
            <span className="live-dot h-1.5 w-1.5 bg-accent-bright" aria-hidden="true" />
            Solana mainnet · live
          </div>
        </Reveal>

        <div className="mt-12 grid gap-12 lg:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)] lg:gap-16">
          <div>
            <Reveal as="p" className="section-label-accent">Public-chain intelligence</Reveal>
            <Reveal as="h1" delay={70} className="mt-5 max-w-4xl font-display text-5xl font-medium leading-[0.98] tracking-[-0.045em] text-marble md:text-7xl">
              Inspect the signal
              <br />
              behind the address.
            </Reveal>
            <Reveal delay={140} as="p" className="mt-7 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
              Turn public Solana activity into an evidence-backed view of exposure, relationships, and observable patterns.
            </Reveal>

            <Reveal delay={210} className="mt-10">
              <AnalyzeForm />
            </Reveal>
          </div>

          <Reveal delay={180} as="aside" className="lg:pt-9">
            <div className="luxury-panel border border-white/10 bg-black/30">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-2">Analysis sequence</span>
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent-bright">Evidence first</span>
              </div>
              <div className="relative px-5 py-2">
                <span className="absolute bottom-8 left-[31px] top-8 w-px bg-gradient-to-b from-accent-bright via-accent/50 to-white/10" aria-hidden="true" />
                <ol>
                  {ANALYSIS_STEPS.map((step) => (
                    <li key={step.number} className="group relative grid grid-cols-[24px_1fr] gap-4 border-b border-white/[0.07] py-6 last:border-0">
                      <span className="relative z-10 flex h-6 w-6 items-center justify-center border border-accent/50 bg-ink-deep font-mono text-[9px] text-accent-bright transition group-hover:border-accent-bright group-hover:bg-accent-dim">
                        {step.number}
                      </span>
                      <div>
                        <h2 className="font-display text-base font-semibold text-marble">{step.title}</h2>
                        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 border border-white/10 bg-black/20">
              <div className="border-r border-white/10 p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">Custody</p>
                <p className="mt-2 font-display text-sm font-semibold text-marble">Never transferred</p>
              </div>
              <div className="p-4">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-2">Method</p>
                <p className="mt-2 font-display text-sm font-semibold text-marble">Public evidence</p>
              </div>
            </div>
          </Reveal>
        </div>

        <Reveal delay={260} className="mt-14 grid border-y border-white/10 sm:grid-cols-3">
          {[
            ["01", "No transaction required"],
            ["02", "Correlation is not identity"],
            ["03", "Confidence shown separately"]
          ].map(([number, label], index) => (
            <div key={number} className={`flex items-center gap-4 px-1 py-4 sm:px-5 ${index < 2 ? "sm:border-r sm:border-white/10" : ""}`}>
              <span className="font-mono text-[10px] text-accent-bright">{number}</span>
              <span className="text-xs text-muted-foreground">{label}</span>
            </div>
          ))}
        </Reveal>
      </div>
    </div>
  );
}
