"use client";

import { useEffect, useState } from "react";
import { getDiscovery, listDiscoveries, type DiscoveryDetailResponse, type DiscoveryListResponse, type DiscoverySummary } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";

const day = (iso: string) => `${iso.slice(0, 10)} — ${iso.slice(11, 16)} UTC`;
const lagText = (d: DiscoverySummary) => d.lagHours === 0 ? "same hour" : `${Math.abs(d.lagHours)}h lag`;

function Card({ discovery, onInvestigate }: { discovery: DiscoverySummary; onInvestigate: () => void }) {
  const { card } = discovery;
  return <li className="rounded-lg border border-ink/10 p-5">
    <p className="text-xs text-muted-2">Discovery #{discovery.id} · {discovery.status.replace("_", " ")}</p>
    <h2 className="mt-1 text-lg text-ink">{card.title}</h2>
    <p className="mt-2 text-sm text-ink/80">{card.summary}</p>
    <p className="mt-3 text-xs text-muted-foreground">Confidence (1 − q): {(card.confidence * 100).toFixed(1)}% · q = {card.qValue.toExponential(2)} across {card.hypothesesTested} hypotheses · r = {card.effect.r} · {lagText(discovery)}</p>
    <p className="mt-1 text-xs text-muted-foreground">First detected: {day(discovery.firstDetectedAt)}</p>
    <button className="btn-primary mt-4 px-4 py-2 text-sm" onClick={onInvestigate}>Investigate →</button>
  </li>;
}

function Detail({ detail }: { detail: DiscoveryDetailResponse }) {
  const { discovery, run } = detail;
  const { card } = discovery;
  const section = (title: string, body: string | string[]) => <div><h3 className="text-sm font-semibold text-ink/80">{title}</h3>
    {Array.isArray(body) ? <ul className="mt-1 text-sm text-muted-foreground">{body.map((line) => <li key={line} className="mt-1">{line}</li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{body}</p>}
  </div>;
  return <section className="mt-8 space-y-5 rounded-lg border border-ink/10 p-5">
    <div>
      <p className="text-xs text-muted-2">Discovery #{discovery.id} · {discovery.status.replace("_", " ")} · first detected {day(discovery.firstDetectedAt)}</p>
      <h2 className="mt-1 text-lg text-ink">{card.title}</h2>
    </div>
    <div><h3 className="text-sm font-semibold text-ink/80">Signal graph</h3>
      <ul className="mt-2 font-mono text-sm text-ink/80">{card.graph.edges.map((edge) => {
        const from = card.graph.nodes.find((n) => n.id === edge.from)?.label ?? edge.from;
        const to = card.graph.nodes.find((n) => n.id === edge.to)?.label ?? edge.to;
        return <li key={`${edge.from}:${edge.to}:${edge.lagHours}`} className="mt-1">{from} {edge.lagHours === 0 ? "↔" : "→"} {to} · r = {edge.r}{edge.lagHours ? ` · ${edge.lagHours}h later` : ""}</li>;
      })}</ul>
      {detail.related.length ? <p className="mt-2 text-xs text-muted-2">Shares a series with: {detail.related.map((r) => `#${r.id}`).join(", ")}</p> : null}
    </div>
    {section("Why this is unusual", card.whyUnusual)}
    {section("When it began", card.whenItBegan)}
    {section("Which signals support it", card.supporting)}
    {section("What contradicts it", card.contradicting)}
    {section("Whether it existed historically", card.historical)}
    {section("What would confirm it next", card.whatWouldConfirm)}
    <div><h3 className="text-sm font-semibold text-ink/80">Record</h3>
      <ul className="mt-1 text-sm text-muted-foreground">{detail.events.map((event) => <li key={`${event.type}:${event.at}`} className="mt-1">{event.at} · {event.type.replace("_", " ")}{typeof event.detail.reason === "string" ? ` — ${event.detail.reason}` : ""}</li>)}</ul>
      <p className="mt-2 break-all text-xs text-muted-2">Chain hash {discovery.chainHash} · previous {discovery.prevChainHash ?? "none (first discovery)"} · fingerprint {discovery.fingerprint}</p>
      <p className="mt-1 text-xs text-muted-2">{card.method} · n = {card.effect.n} (effective {card.effect.nEffective}) · p = {card.pValue.toExponential(2)} · FDR level {card.fdrLevel} · {discovery.engineVersion}{run ? ` · run over ${run.seriesCount} series, ${run.hypothesesTested} tested of ${run.hypothesesConsidered} considered` : ""}</p>
    </div>
    <ul className="text-xs text-muted-2">{card.limitations.map((text) => <li key={text} className="mt-1">{text}</li>)}</ul>
  </section>;
}

export default function Discoveries() {
  const [data, setData] = useState<DiscoveryListResponse | null>(null);
  const [detail, setDetail] = useState<DiscoveryDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, requireAuth } = useRequireAuth();

  // Loads once a session exists; the session is restored asynchronously, so
  // redirecting on mount would bounce a signed-in visitor to the login page.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listDiscoveries()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "Discoveries unavailable"); });
    return () => { cancelled = true; };
  }, [user]);

  async function investigate(id: string) {
    setError(null);
    try { setDetail(await getDiscovery(id)); }
    catch (err) { setError(err instanceof Error ? err.message : "Discovery unavailable"); }
  }

  return <main className="mx-auto max-w-5xl px-4 py-8">
    <h1 className="font-display text-2xl font-semibold text-ink">AEGIX Discovery Engine</h1>
    <p className="mt-2 text-sm text-muted-foreground">Relationships the engine found without being asked. Each one is a statistical relationship between two measured series, corrected for the number of hypotheses tested, and stamped when first detected. It does not establish causation and identifies no participant.</p>
    {error ? <p role="alert" className="mt-6 text-sm text-amber-800">{error}</p> : null}
    {!user ? <button className="btn-primary mt-6 px-4 py-2 text-sm" onClick={() => void requireAuth()}>Sign in to view discoveries</button> : null}
    {data ? <>
      <p className="mt-4 text-xs text-muted-2">{data.latestRun
        ? `Latest scan: epoch ending ${data.latestRun.epochEnd} · ${data.latestRun.hypothesesTested} hypotheses tested of ${data.latestRun.hypothesesConsidered} considered · ${data.latestRun.rejections} significant after correction · ${data.latestRun.engineVersion}`
        : "The engine has not completed a scan yet."}</p>
      {data.discoveries.length === 0
        ? <p className="mt-6 text-sm text-muted-foreground">No discovery on record. A scan that finds nothing is the expected result most days; it is not evidence that the series are unrelated.</p>
        : <ul className="mt-6 space-y-4">{data.discoveries.map((discovery) => <Card key={discovery.id} discovery={discovery} onInvestigate={() => void investigate(discovery.id)} />)}</ul>}
    </> : null}
    {detail ? <Detail detail={detail} /> : null}
  </main>;
}
