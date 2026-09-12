"use client";

import { useRef, useState } from "react";
import { getMarket, type MarketAsset, type MarketResponse } from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";
import AskAegix from "@/components/ask-aegix";

const usd = (value: number | null) => value === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);

export default function Markets() {
  const [asset, setAsset] = useState<MarketAsset>("SOL");
  const [wallet, setWallet] = useState("");
  const [data, setData] = useState<MarketResponse | null>(null);
  const [loadedWallet, setLoadedWallet] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const { requireAuth } = useRequireAuth();
  async function load() {
    const current = ++generation.current;
    setLoading(true); setError(null); setData(null);
    try {
      const result = await getMarket(asset, wallet.trim() || undefined);
      if (current !== generation.current) return;
      setData(result); setLoadedWallet(wallet.trim());
    } catch (err) { if (current === generation.current) setError(err instanceof Error ? err.message : "Markets unavailable"); }
    finally { if (current === generation.current) setLoading(false); }
  }
  const snapshot = data?.snapshot;
  return <main className="mx-auto max-w-5xl px-4 py-8">
    <h1 className="font-display text-2xl font-semibold text-marble">Markets Intelligence</h1>
    <p className="mt-2 text-sm text-muted-foreground">BTC, ETH and SOL prices, volume and measured market signals. Anomaly does not establish manipulation. Temporal correlation does not establish causation.</p>
    <form className="mt-6 flex flex-wrap gap-3" onSubmit={(event) => { event.preventDefault(); void requireAuth(load); }}>
      <label className="text-sm text-slate-300">Asset
        <select aria-label="Asset" value={asset} onChange={(e) => { generation.current++; setLoading(false); setData(null); setAsset(e.target.value as MarketAsset); }} className="ml-2 rounded-lg border border-white/10 bg-ink-deep px-3 py-2">
          {["BTC", "ETH", "SOL"].map((symbol) => <option key={symbol}>{symbol}</option>)}
        </select>
      </label>
      <input aria-label="Optional Solana wallet context" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Optional Solana wallet context" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-100" />
      <button className="btn-primary px-4 py-2 text-sm" disabled={loading}>{loading ? "Loading…" : "Load market"}</button>
    </form>
    {error ? <p role="alert" className="mt-6 text-sm text-amber-300">{error}</p> : null}
    {snapshot && data ? <section className="mt-8 space-y-6">
      <div className="rounded-lg border border-white/10 p-5">
        <h2 className="text-xl text-slate-100">{data.asset} · {snapshot.quote.freshness.status === "UNAVAILABLE" ? "Current price unavailable" : usd(snapshot.quote.priceUsd)}</h2>
        <p className="mt-2 text-sm text-slate-300">Rolling 24h volume: {snapshot.quote.freshness.status === "UNAVAILABLE" ? "Unavailable" : usd(snapshot.quote.volume24hUsd)}</p>
        <p className="mt-2 text-xs text-slate-400">{snapshot.quote.provider} · {snapshot.quote.freshness.status} · quality {snapshot.quality.grade} · {snapshot.providerStatus}</p>
        <p className="mt-1 text-xs text-slate-500">Provider timestamp: {snapshot.quote.freshness.providerTimestamp ?? "Unavailable"} · age {snapshot.quote.freshness.ageSeconds ?? "unknown"}s</p>
        {snapshot.quality.issues.map((issue) => <p key={issue} className="mt-2 text-xs text-amber-300">{issue}</p>)}
      </div>
      <div><h2 className="text-sm font-semibold text-slate-300">Deterministic signals</h2>
        {snapshot.signals.length === 0 ? <p className="mt-3 text-sm text-slate-400">No signal met its data and threshold requirements. This does not establish market stability.</p> :
          <ul className="mt-3 space-y-3">{snapshot.signals.map((signal) => <li key={signal.id} className="rounded-lg border border-white/10 p-4">
            <h3 className="text-sm text-slate-100">{signal.title}</h3><p className="mt-2 text-sm text-slate-300">{signal.summary}</p>
            <p className="mt-2 text-xs text-slate-500">{signal.id} · severity {signal.severity} · confidence {(signal.confidence * 100).toFixed(0)}% · {signal.engineVersion}</p>
            <dl className="mt-2 text-xs text-slate-400">{signal.evidence.map((item) => <div key={item.key}>{item.label}: {String(item.value)}</div>)}</dl>
          </li>)}</ul>}
      </div>
      <details className="rounded-lg border border-white/10 p-4"><summary className="cursor-pointer text-sm text-slate-300">Bounded hourly history · {snapshot.history.length} observations</summary>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs text-slate-400"><thead><tr><th>UTC observation</th><th>USD price</th><th>Rolling 24h USD volume</th></tr></thead>
          <tbody>{snapshot.history.map((point) => <tr key={point.timestamp}><td className="py-2">{point.timestamp}</td><td>{usd(point.priceUsd)}</td><td>{usd(point.volumeUsd)}</td></tr>)}</tbody>
        </table></div>
      </details>
      {loadedWallet ? <div><h2 className="text-sm text-slate-300">Solana temporal context</h2>
        {data.temporalContext.length ? data.temporalContext.map((entry) => <p key={entry.id} className="mt-2 text-xs text-slate-400">{entry.onChainTimestamp} → {entry.marketTimestamp} ({entry.offsetSeconds}s). {entry.note} Evidence: {entry.evidenceRefs.join(", ")}</p>) : <p className="mt-2 text-xs text-slate-400">No timestamped deterministic wallet evidence overlaps the bounded market history.</p>}
        {data.contextLimitations?.map((text) => <p key={text} className="mt-2 text-xs text-slate-500">{text}</p>)}
      </div> : null}
      <ul className="text-xs text-slate-500">{snapshot.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      <AskAegix key={`${data.asset}:${loadedWallet}`} wallet={loadedWallet} market={data.asset} />
      <p className="text-xs text-slate-500">Market requests today: {data.quota.used}/{data.quota.limit}. Resets {data.quota.resetAt}.</p>
    </section> : null}
  </main>;
}
