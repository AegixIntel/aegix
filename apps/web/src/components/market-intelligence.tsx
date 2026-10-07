"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  getAnomalies, getCrossMarket, getNarrativeRadar, getSignalFeed,
  type AnomaliesResponse, type CaptureCoverage, type CrossMarketResponse, type NarrativeRadarResponse, type NarrativeTopicReading, type SignalFeedResponse
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";

/**
 * D15 pages: Narrative Radar, Anomaly Detection, the Signal Engine and
 * Cross-Market Intelligence. Each shows what the API measured on the record
 * AEGIX already holds, with its limits printed under it.
 */

const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const words = (value: string) => value.replace(/_/g, " ").toLowerCase();
const signed = (value: number | null, unit = "%") => value === null ? "—" : `${value > 0 ? "+" : ""}${value}${unit}`;
const WINDOWS = [24, 72, 168];

/**
 * Loads once a session exists, and again when `key` changes. The session is
 * restored asynchronously, so loading on mount would fail for a signed-in visitor.
 */
function useSignedInData<T>(load: () => Promise<T>, key: unknown, unavailable: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, requireAuth } = useRequireAuth();
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setError(null);
    load()
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : unavailable); });
    return () => { cancelled = true; };
    // `load` is a new function on every render; `key` is what says the request changed.
  }, [user, key]);
  return { data, error, user, requireAuth };
}

function Page({ title, lead, error, signedIn, onSignIn, children }: { title: string; lead: string; error: string | null; signedIn: boolean; onSignIn: () => void; children: ReactNode }) {
  return <main className="mx-auto max-w-5xl px-4 py-8">
    <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{lead}</p>
    {error ? <p role="alert" className="mt-6 text-sm text-amber-800">{error === "FEATURE_DISABLED" ? "This feature is not switched on in this deployment." : error}</p> : null}
    {!signedIn ? <button className="btn-primary mt-6 px-4 py-2 text-sm" onClick={onSignIn}>Sign in to view</button> : null}
    {children}
  </main>;
}

function Limitations({ items }: { items: string[] }) {
  return <ul className="mt-8 border-t border-ink/10 pt-4 text-xs text-muted-2">{items.map((text) => <li key={text} className="mt-1">{text}</li>)}</ul>;
}

function WindowPicker({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return <div className="mt-4 flex gap-2 text-xs">{WINDOWS.map((option) =>
    <button key={option} aria-pressed={option === hours} onClick={() => onChange(option)}
      className={`rounded border px-3 py-1 ${option === hours ? "border-ink/40 text-ink" : "border-ink/10 text-muted-foreground"}`}>{option < 48 ? `${option}h` : `${option / 24} days`}</button>)}
  </div>;
}

function coverageLine(coverage: CaptureCoverage): string {
  return coverage.captures === 0
    ? "no capture in this window"
    : `${coverage.captures} captures of ${coverage.subjects} subjects, ${coverage.signalled} holding a signal`;
}

// ---------------------------------------------------------------------------

/** Hourly counts as bars. Hours the record does not hold are left as gaps. */
function MentionBars({ series, asOf }: { series: NarrativeTopicReading["series"]; asOf: string }) {
  const hours = 72;
  const end = Math.floor(Date.parse(asOf) / 3_600_000);
  const byHour = new Map(series.map((point) => [Math.floor(Date.parse(point.hour) / 3_600_000), point.mentions]));
  const max = Math.max(1, ...series.map((point) => point.mentions));
  return <svg viewBox={`0 0 ${hours * 3} 32`} className="mt-3 h-8 w-full text-ink/60" preserveAspectRatio="none" role="img" aria-label={`Articles per hour over the last ${hours} hours`}>
    {Array.from({ length: hours }, (_, i) => {
      const value = byHour.get(end - hours + 1 + i);
      if (value === undefined) return null;
      const height = Math.max(1, (value / max) * 30);
      return <rect key={i} x={i * 3} y={32 - height} width={2} height={height} fill="currentColor" />;
    })}
  </svg>;
}

export function NarrativeRadar() {
  const { data, error, user, requireAuth } = useSignedInData<NarrativeRadarResponse>(getNarrativeRadar, null, "Narrative Radar unavailable");
  return <Page title="Narrative Radar" error={error} signedIn={Boolean(user)} onSignIn={() => void requireAuth()}
    lead="Which news topics are being written about more, or less, than in the two days before. Counted in articles per hour; it measures how much is published, not sentiment and not whether the coverage is right.">
    {data ? <>
      <p className="mt-4 text-xs text-muted-2">As of {stamp(data.asOf)} · newest {data.recentHours} read hours against the {data.baselineHours} before · {data.engineVersion}</p>
      {!data.capture.mentions ? <p className="mt-2 text-xs text-amber-800">The news capture is switched off in this deployment, so the counts below are whatever was stored before.</p> : null}
      <ul className="mt-6 grid gap-4 md:grid-cols-2">{data.topics.map((topic) => <li key={topic.topic} className="rounded-lg border border-ink/10 p-5">
        <p className={`text-xs uppercase tracking-[0.12em] ${topic.state === "ACCELERATING" ? "text-accent" : "text-muted-2"}`}>{words(topic.state)}</p>
        <h2 className="mt-1 text-lg text-ink">{topic.label}</h2>
        {topic.recentMean === null
          ? <p className="mt-2 text-sm text-muted-foreground">Too few hours on record to measure: {topic.recentHours} of {data.recentHours} recent, {topic.baselineHours} of {data.baselineHours} before.</p>
          : <p className="mt-2 text-sm text-ink/80">{topic.recentMean} articles an hour, against {topic.baselineMean} before{topic.ratio !== null ? ` · ${topic.ratio}×` : ""}</p>}
        <MentionBars series={topic.series} asOf={data.asOf} />
        <p className="mt-1 text-xs text-muted-2">{topic.latestHour ? `Newest hour on record: ${stamp(topic.latestHour)}` : "No hour on record."}</p>
        {topic.storedSignals.length ? <ul className="mt-3 text-xs text-muted-foreground">{topic.storedSignals.map((signal) =>
          <li key={`${signal.observedAt}:${signal.type}`} className="mt-1">{stamp(signal.observedAt)} · {signal.title}</li>)}</ul> : null}
        <p className="mt-3 text-xs"><Link className="text-ink underline decoration-ink/30 underline-offset-2 hover:decoration-accent" href={`/app/rewind?type=narrative&subject=${encodeURIComponent(topic.topic)}&lookback=72`}>Rewind this topic</Link></p>
      </li>)}</ul>
      <Limitations items={data.limitations} />
    </> : null}
  </Page>;
}

// ---------------------------------------------------------------------------

export function Anomalies() {
  const [hours, setHours] = useState(72);
  const { data, error, user, requireAuth } = useSignedInData<AnomaliesResponse>(() => getAnomalies(hours), hours, "Anomalies unavailable");
  return <Page title="Anomaly Detection" error={error} signedIn={Boolean(user)} onSignIn={() => void requireAuth()}
    lead="Hourly changes far outside what the same series did in the two weeks before. Each one was measured once, when the hour was first seen, and stored. A large move is not a cause, a forecast or advice.">
    {user ? <WindowPicker hours={hours} onChange={setHours} /> : null}
    {data ? <>
      <p className="mt-4 text-xs text-muted-2">Last {data.windowHours} hours · {coverageLine(data.coverage)} · threshold {data.rule.threshold} robust standard deviations over a {data.rule.baselineHours}-hour baseline · {data.engineVersion}</p>
      {!data.capture ? <p className="mt-2 text-xs text-amber-800">The anomaly capture is switched off in this deployment, so nothing new is being stored.</p> : null}
      {data.anomalies.length === 0
        ? <p className="mt-6 text-sm text-muted-foreground">{data.coverage.captures === 0
          ? "No series was read in this window, so there is no record either way."
          : "No anomaly on record in this window. That is the usual result: most hours are ordinary."}</p>
        : <ul className="mt-6 space-y-4">{data.anomalies.map((anomaly) => <li key={`${anomaly.id}:${anomaly.type}`} className="rounded-lg border border-ink/10 p-5">
          <p className="text-xs uppercase tracking-[0.12em] text-accent">{words(anomaly.marketClass)} · severity {anomaly.severity}</p>
          <h2 className="mt-1 text-lg text-ink">{anomaly.title}</h2>
          <p className="mt-2 text-sm text-ink/80">{anomaly.summary}</p>
          <ul className="mt-3 grid gap-x-6 text-xs text-muted-foreground sm:grid-cols-2">{anomaly.evidence.map((item) => <li key={item.key} className="mt-1">{item.label}: {String(item.value)}</li>)}</ul>
          <p className="mt-3 text-xs text-muted-2">Stored {stamp(anomaly.observedAt)} · baseline quality {words(anomaly.qualityGrade)} · {anomaly.engineVersion}</p>
        </li>)}</ul>}
      {data.truncated ? <p className="mt-4 text-xs text-muted-2">Only the newest anomalies of this window are listed.</p> : null}
      <Limitations items={data.limitations} />
    </> : null}
  </Page>;
}

// ---------------------------------------------------------------------------

export function SignalFeed() {
  const [hours, setHours] = useState(24);
  const { data, error, user, requireAuth } = useSignedInData<SignalFeedResponse>(() => getSignalFeed(hours), hours, "Signals unavailable");
  return <Page title="Signal Engine" error={error} signedIn={Boolean(user)} onSignIn={() => void requireAuth()}
    lead="Every signal AEGIX stored, across crypto assets, tokenized stocks, news topics and funds, on one timeline, with the moments several market classes held one at once. It claims no link between them.">
    {user ? <WindowPicker hours={hours} onChange={setHours} /> : null}
    {data ? <>
      <p className="mt-4 text-xs text-muted-2">Last {data.windowHours} hours · {data.capturesRead} captures holding a signal · {data.engineVersion}</p>
      <ul className="mt-2 text-xs text-muted-2">{data.coverage.map((coverage) => <li key={coverage.domain}>{words(coverage.domain)}: {coverageLine(coverage)}</li>)}</ul>
      {data.truncated ? <p className="mt-2 text-xs text-amber-800">This window holds more captures than one answer reads; the oldest are left out.</p> : null}

      <h2 className="mt-8 text-sm font-semibold text-ink/80">Confluences</h2>
      {data.confluences.length === 0
        ? <p className="mt-2 text-sm text-muted-foreground">No moment in this window had signals of {data.rule.confluenceMinClasses} market classes within {data.rule.confluenceWindowHours} hours of each other.</p>
        : <ul className="mt-3 space-y-4">{data.confluences.map((confluence) => <li key={confluence.from} className="rounded-lg border border-ink/30 p-5">
          <p className="text-xs uppercase tracking-[0.12em] text-accent">{confluence.classes.length} market classes</p>
          <h3 className="mt-1 text-lg text-ink">{confluence.classes.map(words).join(", ")}</h3>
          <p className="mt-1 text-xs text-muted-2">{stamp(confluence.from)} to {stamp(confluence.to)}</p>
          <ul className="mt-3 text-sm text-muted-foreground">{confluence.subjects.map((subject) =>
            <li key={`${subject.marketClass}:${subject.subject}`} className="mt-1">{subject.label} — {subject.signalTypes.map(words).join(", ")}</li>)}</ul>
        </li>)}</ul>}

      <h2 className="mt-8 text-sm font-semibold text-ink/80">Signals</h2>
      {data.entries.length === 0
        ? <p className="mt-2 text-sm text-muted-foreground">No signal on record in this window.</p>
        : <ul className="mt-3 divide-y divide-ink/10">{data.entries.map((entry) => <li key={`${entry.domain}:${entry.subject}:${entry.signalType}`} className="py-3">
          <p className="text-sm text-ink">{entry.title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{entry.summary}</p>
          <p className="mt-1 text-xs text-muted-2">{words(entry.marketClass)} · {entry.label} · peak severity {entry.peakSeverity} · {entry.captures === 1 ? `stored ${stamp(entry.firstObservedAt)}` : `in ${entry.captures} captures, ${stamp(entry.firstObservedAt)} to ${stamp(entry.lastObservedAt)}`}</p>
        </li>)}</ul>}
      <Limitations items={data.limitations} />
    </> : null}
  </Page>;
}

// ---------------------------------------------------------------------------

export function CrossMarket() {
  const { data, error, user, requireAuth } = useSignedInData<CrossMarketResponse>(getCrossMarket, null, "Cross-market view unavailable");
  return <Page title="Cross-Market Intelligence" error={error} signedIn={Boolean(user)} onSignIn={() => void requireAuth()}
    lead="How the market classes AEGIX captures stand against each other: each one's day and week, how many of its members rose, how their hourly moves correlated over the week, and where each sector fund's day sits among the others.">
    {data ? <>
      <p className="mt-4 text-xs text-muted-2">As of {stamp(data.asOf)} · {data.engineVersion}</p>
      {data.classes.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">No price capture is switched on in this deployment, so there is nothing to compare.</p> : null}

      {data.readings.length ? <ul className="mt-6 space-y-3">{data.readings.map((reading) => <li key={reading.title} className="rounded-lg border border-ink/30 p-4">
        <p className="text-sm text-ink">{reading.title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{reading.summary}</p>
      </li>)}</ul> : null}

      <div className="mt-6 grid gap-4 md:grid-cols-2">{data.classes.map((group) => <section key={group.marketClass} className="rounded-lg border border-ink/10 p-5">
        <p className="text-xs uppercase tracking-[0.12em] text-muted-2">{words(group.marketClass)}{group.session ? " · US session, delayed" : ""}</p>
        <p className="mt-1 text-lg text-ink">{group.median24hPercent === null ? "Not measured" : `${signed(group.median24hPercent)} median on the day`}</p>
        <p className="mt-1 text-xs text-muted-foreground">{group.measured === 0 ? "No member has both a current price and one to compare it with." : `${group.advancing} of ${group.measured} up`}{group.median7dPercent !== null ? ` · ${signed(group.median7dPercent)} median over 7 days` : ""}</p>
        <table className="mt-3 w-full text-xs text-muted-foreground"><tbody>{group.members.map((member) => <tr key={member.symbol} title={member.label}>
          <td className="py-0.5 text-ink/80">{member.symbol}</td>
          <td className="py-0.5 text-right">{member.price === null ? "no current price" : member.price}</td>
          <td className="py-0.5 text-right">{signed(member.return24hPercent)}</td>
          {group.session ? null : <td className="py-0.5 text-right">{signed(member.return7dPercent)}</td>}
        </tr>)}</tbody></table>
      </section>)}</div>

      {data.correlations.length ? <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink/80">How the classes moved together over the week</h2>
        <ul className="mt-2 text-sm text-muted-foreground">{data.correlations.map((pair) => <li key={`${pair.a}:${pair.b}`} className="mt-1">
          {words(pair.a)} and {words(pair.b)}: {pair.r === null ? `not measured, ${pair.pairedHours} shared hours on record` : `r = ${pair.r} over ${pair.pairedHours} shared hours`}</li>)}</ul>
      </section> : null}

      {data.sectors.length ? <section className="mt-8">
        <h2 className="text-sm font-semibold text-ink/80">Sector funds on the day</h2>
        <ul className="mt-2 text-sm text-muted-foreground">{data.sectors.map((sector) => <li key={sector.symbol} className="mt-1" title={sector.label}>
          {sector.symbol}: {signed(sector.dayReturnPercent)} · {signed(sector.excessPoints, " pts")} against the median sector fund</li>)}</ul>
      </section> : null}
      <Limitations items={data.limitations} />
    </> : null}
  </Page>;
}
