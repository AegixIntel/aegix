"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { discoveryProofUrl, getDiscovery, listDiscoveries, type DiscoveryDetailResponse, type DiscoveryListResponse, type DiscoverySummary } from "@/lib/api";
import { SignalGraph } from "@/components/signal-graph";
import { useRequireAuth } from "@/lib/auth-guard";

const day = (iso: string) => `${iso.slice(0, 10)} — ${iso.slice(11, 16)} UTC`;
const daily = (d: DiscoverySummary) => d.engineVersion.startsWith("discovery-daily");
const lagText = (d: DiscoverySummary) => d.lagHours === 0 ? (daily(d) ? "same day" : "same hour") : daily(d) ? `${Math.abs(d.lagHours) / 24}d lag` : `${Math.abs(d.lagHours)}h lag`;
/** How long the discovery has been on record, counted from its stamp. */
function age(iso: string): string {
  const hours = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000);
  return hours < 1 ? "less than an hour ago" : hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)} days ago`;
}
/** The Rewind subject a series belongs to: market assets and tokenized stocks can be replayed, other series cannot. */
function rewindSubject(seriesKey: string): string | null {
  return /^(?:market|xstock):([^:]+):/.exec(seriesKey)?.[1] ?? null;
}

/** What a card is showing under its discovery: a request in flight, the detail, or why it could not be read. */
type Investigation = { state: "loading" } | { state: "open"; detail: DiscoveryDetailResponse } | { state: "failed"; message: string };

function Card({ discovery, investigation, onToggle }: { discovery: DiscoverySummary; investigation: Investigation | undefined; onToggle: () => void }) {
  const { card } = discovery;
  const opened = useRef<HTMLDivElement>(null);
  const open = investigation?.state === "open";
  // The detail is long and opens under the card, so it is brought into view:
  // a click that changes nothing on screen reads as a button that is broken.
  useEffect(() => {
    if (open) opened.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);
  return <li className={`rounded-lg border p-5 ${investigation ? "border-ink/30" : "border-ink/10"}`}>
    <p className="text-xs uppercase tracking-[0.12em] text-accent">AEGIX found something</p>
    <p className="mt-1 text-xs text-muted-2">Discovery #{discovery.id} · {discovery.status.replace("_", " ")}</p>
    <h2 className="mt-1 text-lg text-ink">{card.title}</h2>
    <p className="mt-2 text-sm text-ink/80">{card.summary}</p>
    <p className="mt-3 text-xs text-muted-foreground">Confidence (1 − q): {(card.confidence * 100).toFixed(1)}% · q = {card.qValue.toExponential(2)} across {card.hypothesesTested} hypotheses · r = {card.effect.r} · {lagText(discovery)}</p>
    <p className="mt-1 text-xs text-muted-foreground">First detected: {day(discovery.firstDetectedAt)} · {age(discovery.firstDetectedAt)}</p>
    <button className="btn-primary mt-4 px-4 py-2 text-sm" onClick={onToggle} disabled={investigation?.state === "loading"} aria-expanded={open}>
      {investigation?.state === "loading" ? "Opening…" : open ? "Close" : "Investigate →"}
    </button>
    {investigation?.state === "failed" ? <p role="alert" className="mt-3 text-sm text-amber-800">{investigation.message}</p> : null}
    {open ? <div ref={opened} className="scroll-mt-20"><Detail detail={investigation.detail} /></div> : null}
  </li>;
}

function Detail({ detail }: { detail: DiscoveryDetailResponse }) {
  const { discovery, run } = detail;
  const { card } = discovery;
  const subjects = [...new Set([discovery.seriesA, discovery.seriesB].map(rewindSubject).filter((s): s is string => s !== null))];
  const section =(title: string, body: string | string[]) => <div><h3 className="text-sm font-semibold text-ink/80">{title}</h3>
    {Array.isArray(body) ? <ul className="mt-1 text-sm text-muted-foreground">{body.map((line) => <li key={line} className="mt-1">{line}</li>)}</ul> : <p className="mt-1 text-sm text-muted-foreground">{body}</p>}
  </div>;
  return <section className="mt-6 space-y-5 border-t border-ink/10 pt-6">
    <div><h3 className="text-sm font-semibold text-ink/80">Signal graph</h3>
      <SignalGraph card={card} related={detail.related} />
      <ul className="mt-3 font-mono text-sm text-ink/80">{card.graph.edges.map((edge) => {
        const from = card.graph.nodes.find((n) => n.id === edge.from)?.label ?? edge.from;
        const to = card.graph.nodes.find((n) => n.id === edge.to)?.label ?? edge.to;
        return <li key={`${edge.from}:${edge.to}:${edge.lagHours}`} className="mt-1">{from} {edge.lagHours === 0 ? "↔" : "→"} {to} · r = {edge.r}{edge.lagHours ? ` · ${daily(discovery) ? `${edge.lagHours / 24}d` : `${edge.lagHours}h`} later` : ""}</li>;
      })}</ul>
      {detail.related.length ? <p className="mt-2 text-xs text-muted-2">Shares a series with: {detail.related.map((r) => `#${r.id}`).join(", ")}</p> : null}
    </div>
    {subjects.length ? <p className="text-sm text-muted-foreground">Rewind to before this was stamped, and see what AEGIX had stored by then: {subjects.map((subject, i) => <span key={subject}>{i ? " · " : ""}
      <Link className="text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-accent" href={`/app/rewind?subject=${encodeURIComponent(subject)}&eventTime=${encodeURIComponent(discovery.firstDetectedAt)}&lookback=72`}>{subject}</Link></span>)}</p> : null}
    {section("Why this is unusual", card.whyUnusual)}
    {section("When it began", card.whenItBegan)}
    {section("Which signals support it", card.supporting)}
    {section("What contradicts it", card.contradicting)}
    {section("Whether it existed historically", card.historical)}
    {section("What would confirm it next", card.whatWouldConfirm)}
    <div><h3 className="text-sm font-semibold text-ink/80">Record</h3>
      <ul className="mt-1 text-sm text-muted-foreground">{detail.events.map((event) => <li key={`${event.type}:${event.at}`} className="mt-1">{event.at} · {event.type.replace("_", " ")}{typeof event.detail.reason === "string" ? ` — ${event.detail.reason}` : ""}</li>)}</ul>
      <p className="mt-2 break-all text-xs text-muted-2">Chain hash {discovery.chainHash} · previous {discovery.prevChainHash ?? "none (first discovery)"} · fingerprint {discovery.fingerprint}</p>
      {detail.anchors.length ? <div className="mt-3 text-xs text-muted-foreground">
        <p>Anchored outside AEGIX: the chain up to Discovery #{detail.anchors[0]!.covers} was sent to {detail.anchors.length} public OpenTimestamps calendar{detail.anchors.length === 1 ? "" : "s"} at {day(detail.anchors[0]!.submittedAt)}, which commit it to the Bitcoin chain.</p>
        <ul className="mt-1">{detail.anchors.map((anchor) => <li key={anchor.id} className="mt-1"><a className="underline decoration-ink/30 underline-offset-2 hover:decoration-accent" href={discoveryProofUrl(anchor)}>Proof file (.ots)</a> · {anchor.calendar.replace(/^https:\/\//, "")}</li>)}</ul>
        <p className="mt-1 text-muted-2">Check it with the OpenTimestamps client: <span className="font-mono">ots verify -d {detail.anchors[0]!.chainHash} &lt;file&gt;.ots</span>. A proof is pending until the calendar&apos;s Bitcoin block is mined, usually within a few hours.</p>
      </div> : <p className="mt-3 text-xs text-muted-2">Not anchored outside AEGIX yet: until it is, this timestamp rests on AEGIX&apos;s own database.</p>}
      <p className="mt-1 text-xs text-muted-2">{card.method} · n = {card.effect.n} (effective {card.effect.nEffective}) · p = {card.pValue.toExponential(2)} · FDR level {card.fdrLevel} · {discovery.engineVersion}{run ? ` · run over ${run.seriesCount} series, ${run.hypothesesTested} tested of ${run.hypothesesConsidered} considered` : ""}</p>
    </div>
    <ul className="text-xs text-muted-2">{card.limitations.map((text) => <li key={text} className="mt-1">{text}</li>)}</ul>
  </section>;
}

export default function Discoveries() {
  const [data, setData] = useState<DiscoveryListResponse | null>(null);
  const [investigations, setInvestigations] = useState<Record<string, Investigation>>({});
  const inFlight = useRef(new Set<string>());
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

  /** Opens a discovery under its own card, or closes it if it is open. */
  async function toggle(id: string) {
    // Clicks can land faster than a render: the ref is what stops a second request.
    if (inFlight.current.has(id)) return;
    if (investigations[id]?.state === "open") {
      setInvestigations(({ [id]: _closed, ...rest }) => rest);
      return;
    }
    inFlight.current.add(id);
    setInvestigations((all) => ({ ...all, [id]: { state: "loading" } }));
    try {
      const detail = await getDiscovery(id);
      setInvestigations((all) => ({ ...all, [id]: { state: "open", detail } }));
    } catch (err) {
      setInvestigations((all) => ({ ...all, [id]: { state: "failed", message: err instanceof Error ? err.message : "Discovery unavailable" } }));
    } finally {
      inFlight.current.delete(id);
    }
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
        : <ul className="mt-6 space-y-4">{data.discoveries.map((discovery) => <Card key={discovery.id} discovery={discovery} investigation={investigations[discovery.id]} onToggle={() => void toggle(discovery.id)} />)}</ul>}
    </> : null}
  </main>;
}
