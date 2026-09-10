"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * AEGIX Interactive System Map.
 *
 * Explains how public wallet activity becomes AEGIX intelligence through a
 * data-driven pipeline of six stages. Modeled on the process/state
 * choreography of a staged process map, recreated for AEGIX.
 *
 * Behaviors:
 *  - autoplays through stages when in view (~2600ms dwell)
 *  - pauses on hover/focus/click, resumes after ~3s idle
 *  - pauses when tab hidden or section out of viewport
 *  - keyboard accessible (Tab/Enter/Space, ArrowLeft/Right)
 *  - reduced-motion: static map, manual selection only
 *  - each stage carries a local visualization animated only while active
 */

export type StageId =
  | "SIGNAL"
  | "EVIDENCE"
  | "RELATIONSHIP"
  | "GRAPH"
  | "EXPOSURE"
  | "INTELLIGENCE";

interface Stage {
  id: StageId;
  category: string;
  title: string;
  action: string;
  description: string;
  /** small secondary detail line */
  detail: string;
}

const STAGES: Stage[] = [
  {
    id: "SIGNAL",
    category: "Signal",
    title: "Wallet Activity",
    action: "Observe",
    description:
      "AEGIX begins with public on-chain activity: transactions, token movements, protocol interactions, and counterparties.",
    detail: "Transactions · Token mocks · Protocol · Counterparties"
  },
  {
    id: "EVIDENCE",
    category: "Evidence",
    title: "Funding · Counterparty · Behavior",
    action: "Normalize",
    description:
      "Independent observations are normalized into evidence families before relationship scoring begins.",
    detail: "Funding · Counterparty · Behavior · Entity · Protocol · Temporal"
  },
  {
    id: "RELATIONSHIP",
    category: "Relationship",
    title: "Correlation Engine",
    action: "Correlate",
    description:
      "Multiple evidence families are combined while common activity and weak observations are discounted.",
    detail: "Multi-evidence · Population-aware"
  },
  {
    id: "GRAPH",
    category: "Graph",
    title: "Paths · Clusters",
    action: "Trace",
    description:
      "AEGIX traces bounded relationship paths and surfaces the strongest observable routes between wallets and entities.",
    detail: "Multi-hop · Bounded · Cluster hypotheses"
  },
  {
    id: "EXPOSURE",
    category: "Exposure",
    title: "7 Dimensions",
    action: "Score",
    description:
      "Observable signals are evaluated across seven privacy-exposure dimensions while score and confidence remain separate.",
    detail: "Linkability · Funding · Entity · Cluster · Behavior · Counterparty · Pattern"
  },
  {
    id: "INTELLIGENCE",
    category: "Intelligence",
    title: "Evidence · Confidence",
    action: "Interpret",
    description:
      "AEGIX turns observable blockchain evidence into explainable intelligence without treating correlation as proof of ownership or identity.",
    detail: "Evidence · Strength · Confidence · Limitations"
  }
];

const DWELL_MS = 2600;
const RESUME_MS = 3000;

function fmt(n: number) {
  return String(n + 1).padStart(2, "0");
}

/* ---------------------------- visuals ---------------------------- */

function SignalVisual() {
  const rows = ["Transactions", "Token movement", "Protocol interactions", "Counterparties"];
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {rows.map((r, i) => (
        <div key={r} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" style={{ opacity: 0.5 + i * 0.12 }} aria-hidden="true" />
          <span className="font-mono text-xs text-muted-foreground">{r}</span>
        </div>
      ))}
    </div>
  );
}

function EvidenceVisual() {
  const fams = ["Funding", "Counterparty", "Behavior", "Entity", "Protocol", "Temporal"];
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" aria-hidden="true">
      {fams.map((f, i) => (
        <span key={f} className="rounded-sm border border-white/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {f}
        </span>
      ))}
    </div>
  );
}

function RelationshipVisual() {
  const fams = ["Funding", "Counterparty", "Behavior", "Temporal", "Entity"];
  return (
    <div className="space-y-1.5" aria-hidden="true">
      <div className="flex items-center justify-between font-mono text-xs">
        <span>Wallet A</span>
        <span className="text-muted-2">⇔</span>
        <span>Wallet B</span>
      </div>
      {fams.map((f) => (
        <div key={f} className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="w-20 shrink-0">{f}</span>
          <span className="h-0.5 flex-1 rounded bg-white/10" aria-hidden="true" />
          <span className="w-4 text-right">▸</span>
        </div>
      ))}
    </div>
  );
}

function GraphVisual() {
  return (
    <div className="font-mono text-[10px] text-muted-foreground" aria-hidden="true">
      <div className="flex items-center gap-2">
        <span className="rounded-sm border border-white/15 px-1.5 py-0.5">Wallet A</span>
        <span className="text-muted-2">─</span>
        <span className="rounded-sm border border-accent/40 px-1.5 py-0.5 text-accent-bright">Wallet B</span>
        <span className="text-muted-2">─</span>
        <span className="rounded-sm border border-white/15 px-1.5 py-0.5">Entity</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="ml-10 rounded-sm border border-white/15 px-1.5 py-0.5">Wallet C</span>
      </div>
    </div>
  );
}

const DIMENSIONS = [
  "Identity Linkability",
  "Funding Exposure",
  "Exchange / Entity Exposure",
  "Wallet Cluster Exposure",
  "Behavioral Fingerprint",
  "Counterparty Exposure",
  "Transaction Pattern Exposure"
];

function ExposureVisual() {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {DIMENSIONS.map((d, i) => (
        <div key={d} className="flex items-center gap-2">
          <span className="w-44 shrink-0 truncate font-mono text-[10px] text-muted-foreground">{d}</span>
          <span className="h-1 flex-1 rounded bg-white/10" aria-hidden="true">
            <span className="block h-full rounded bg-accent" style={{ width: `${32 + i * 9}%` }} aria-hidden="true" />
          </span>
        </div>
      ))}
    </div>
  );
}

function IntelligenceVisual() {
  const items = [
    { k: "Exposure", v: "78 / 100" },
    { k: "Correlation", v: "71 / 100" },
    { k: "Confidence", v: "0.76" },
    { k: "Evidence", v: "5 families" }
  ];
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {items.map((it) => (
        <div key={it.k} className="flex items-center justify-between font-mono text-xs">
          <span className="text-muted-foreground">{it.k}</span>
          <span className="text-marble/90">{it.v}</span>
        </div>
      ))}
      <p className="pt-1 font-mono text-[10px] text-muted-2">Limitation: correlation is not proof of ownership.</p>
    </div>
  );
}

const VISUALS: Record<StageId, React.ReactNode> = {
  SIGNAL: <SignalVisual />,
  EVIDENCE: <EvidenceVisual />,
  RELATIONSHIP: <RelationshipVisual />,
  GRAPH: <GraphVisual />,
  EXPOSURE: <ExposureVisual />,
  INTELLIGENCE: <IntelligenceVisual />
};

/* ---------------------------- component ---------------------------- */

export function InteractiveSystemMap() {
  const [active, setActive] = useState(0);
  const [completed, setCompleted] = useState<boolean[]>(() => STAGES.map(() => false));
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);

  // Detect reduced motion on mount.
  useEffect(() => {
    setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // Track viewport visibility so autoplay only runs in view.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? false),
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Autoplay sequencing.
  useEffect(() => {
    if (reducedMotion || paused || !inView) return;

    const advance = () =>
      setActive((prev) => {
        const next = (prev + 1) % STAGES.length;
        setCompleted((seen) => {
          const copy = [...seen];
          if (next === 0) return STAGES.map(() => false);
          copy[prev] = true;
          return copy;
        });
        return next;
      });

    const timer = setInterval(advance, DWELL_MS);
    return () => clearInterval(timer);
  }, [paused, inView, reducedMotion]);

  // Pause when the tab is hidden.
  useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const select = useCallback((index: number) => {
    setPaused(true);
    setActive(index);
    setCompleted((seen) => {
      const copy = [...seen];
      for (let i = 0; i < index; i++) copy[i] = true;
      return copy;
    });
    // Resume autoplay after a short idle.
    setTimeout(() => setPaused(false), RESUME_MS);
  }, []);

  const stage = STAGES[active]!;

  return (
    <section
      ref={sectionRef}
      className="border-b border-white/10"
      aria-label="AEGIX system map"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="px-4 py-16 md:py-24 lg:px-8">
        {/* header */}
        <div className="max-w-2xl">
          <p className="section-label">The AEGIX System</p>
          <h2 className="mt-6 font-display text-3xl font-semibold tracking-tight text-marble md:text-5xl">
            From activity to intelligence.
          </h2>
          <p className="mt-6 editorial-body">
            A deterministic intelligence pipeline for understanding observable wallet exposure and relationships.
          </p>
        </div>

        <div className="mt-12">
          {/* horizontal rail (desktop) */}
          <div className="hidden md:block">
            <div className="relative">
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" aria-hidden="true" />
              {/* traveling signal */}
              {!reducedMotion && (
                <div
                  className="absolute -top-0.5 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-bright transition-all duration-500 ease-out"
                  style={{ left: `${(active / (STAGES.length - 1)) * 100}%` }}
                  aria-hidden="true"
                />
              )}
              <div className="relative grid grid-cols-6 gap-2">
                {STAGES.map((s, i) => {
                  const isActive = i === active;
                  const isDone = completed[i] || i < active;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => select(i)}
                      onFocus={() => setPaused(true)}
                      onBlur={() => setPaused(false)}
                      className={cn(
                        "relative rounded-md border px-3 py-4 text-left transition-colors duration-300",
                        isActive
                          ? "border-accent/50 bg-accent/5"
                          : isDone
                            ? "border-white/12 bg-white/[0.02]"
                            : "border-white/8 bg-transparent"
                      )}
                      aria-current={isActive ? "step" : undefined}
                    >
                      <span className="flex items-center justify-between">
                        <span className={cn("font-mono text-[10px] uppercase tracking-wide", isActive ? "text-accent-bright" : "text-muted-2")}>
                          {fmt(i)}
                        </span>
                        <span className={cn("h-1.5 w-1.5 rounded-full", isActive ? "bg-accent-bright" : isDone ? "bg-muted-foreground/50" : "bg-white/20")} aria-hidden="true" />
                      </span>
                      <span className={cn("mt-3 block font-display text-sm font-semibold leading-tight", isActive ? "text-marble" : "text-muted-foreground")}>
                        {s.category}
                      </span>
                      <span className="mt-1 block font-mono text-[10px] leading-snug text-muted-2">{s.detail}</span>
                      <span className={cn("mt-3 block font-mono text-[10px] uppercase tracking-[0.14em]", isActive ? "text-accent-bright" : "text-muted-2")}>
                        {s.action}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* detail panel */}
            <div className="system-map-detail mt-6 border border-white/10 p-6" aria-live="polite">
              <div key={stage.id} className="grid gap-6 md:grid-cols-[1fr_16rem]">
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-bright">
                    {fmt(active)} / 0{STAGES.length} · {stage.category}
                  </p>
                  <h3 className="mt-2 font-display text-2xl font-semibold text-marble">{stage.title}</h3>
                  <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">{stage.description}</p>
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">
                    Action · {stage.action}
                  </p>
                </div>
                <div className="rounded-md border border-white/10 p-4">{VISUALS[stage.id]}</div>
              </div>
            </div>
          </div>

          {/* vertical rail (mobile) */}
          <div className="md:hidden">
            <div className="relative">
              <div className="absolute bottom-2 left-2 top-2 w-px bg-white/10" aria-hidden="true" />
              <div className="space-y-1">
                {STAGES.map((s, i) => {
                  const isActive = i === active;
                  const isDone = completed[i] || i < active;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => select(i)}
                      className="relative flex w-full items-start gap-3 rounded-md px-3 py-3 text-left"
                      aria-current={isActive ? "step" : undefined}
                    >
                      <span
                        className={cn(
                          "relative z-10 mt-1 h-2.5 w-2.5 flex-none rounded-full border",
                          isActive ? "border-accent-bright bg-accent-bright" : isDone ? "border-muted-foreground bg-muted-foreground/40" : "border-white/30 bg-transparent"
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0">
                        <span className={cn("flex items-center gap-2", isActive ? "text-marble" : "text-muted-foreground")}>
                          <span className="font-mono text-[10px] text-muted-2">{fmt(i)}</span>
                          <span className="font-display text-sm font-semibold">{s.category}</span>
                        </span>
                        <span className="mt-0.5 block font-mono text-[10px] text-muted-2">{s.detail}</span>
                        {isActive && (
                          <span className="mt-1 block font-mono text-[10px] uppercase tracking-wide text-accent-bright">{s.action}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* active detail */}
            <div className="system-map-detail mt-2 border border-white/10 p-5" aria-live="polite">
              <div key={stage.id}>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-bright">
                  {fmt(active)} / 0{STAGES.length} · {stage.category}
                </p>
                <h3 className="mt-2 font-display text-xl font-semibold text-marble">{stage.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{stage.description}</p>
                <div className="mt-4 rounded-md border border-white/10 p-3">{VISUALS[stage.id]}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
