"use client";

import { useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api";
import { getSessionToken } from "@/lib/auth";

type Transaction = { tx_id: string; height: string; block_time: string | null; success: boolean | null; value_atomic: string | null };
type Cursor = { height: number; position: number };
type History = { wallet: string; coverage: { start_height: string; next_height: string } | null; transactions: Transaction[]; nextCursor: Cursor | null; limitations: string[] };
type Reputation = { status: string; reason: string; accepted: Array<{ claim: { id: string; label: string; sourceUrl: string }; reviewers: string[] }> };
type Economics = { balanceAtomic: string; explanation: string; events: Array<{ event_key: string; amount: string; direction: string; purpose: string }> };
async function read<T>(path: string, envelope = true): Promise<T> {
  const token = getSessionToken();
  if (!token) throw new Error("Connect your wallet and sign in to view network intelligence.");
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session expired. Sign in again.");
    if (response.status === 403) throw new Error("Network intelligence is not enabled on this deployment.");
    if (response.status === 400) throw new Error("Enter a valid address for the selected chain.");
    throw new Error("Network data is unavailable. Please try again.");
  }
  const result = await response.json();
  return envelope ? result.data : result;
}

export default function NetworkIntelligence() {
  const [chain, setChain] = useState("solana:mainnet");
  const [address, setAddress] = useState("");
  const [history, setHistory] = useState<History | null>(null);
  const [reputation, setReputation] = useState<Reputation | null>(null);
  const [economics, setEconomics] = useState<Economics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const selection = useRef({ chain: "", address: "" });
  async function load(more = false) {
    const current = ++generation.current;
    const selected = more ? selection.current : { chain, address: address.trim() };
    const cursor = more ? history?.nextCursor : null;
    setLoading(true); setError("");
    if (!more) { setHistory(null); setReputation(null); setEconomics(null); }
    const path = `${encodeURIComponent(selected.chain)}/${encodeURIComponent(selected.address)}`;
    try {
      const next = await read<History>(`/v1/network/history/${path}?limit=25${cursor ? `&beforeHeight=${cursor.height}&beforePosition=${cursor.position}` : ""}`);
      if (current !== generation.current) return;
      setHistory(previous => more && previous ? { ...next, transactions: [...previous.transactions, ...next.transactions] } : next);
      selection.current = selected;
      if (!more) {
        const [rep, aex] = await Promise.all([read<Reputation>(`/v1/network/reputation/${path}`), read<Economics>("/v1/me/aex", false)]);
        if (current !== generation.current) return;
        setReputation(rep); setEconomics(aex);
      }
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "Request failed"); }
    finally { if (current === generation.current) setLoading(false); }
  }
  return <main className="mx-auto max-w-6xl space-y-8 p-6 text-marble">
    <header><p className="section-label">Network intelligence</p><h1 className="mt-2 text-3xl">Explore indexed wallet activity</h1>
      <p className="mt-3 text-muted-foreground">Inspect observed activity and reviewed evidence across Solana, Ethereum and Base.</p></header>
    <form className="flex flex-wrap items-end gap-4" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label className="space-y-2">Chain<select className="block rounded border border-white/20 bg-ink-deep p-3" value={chain} onChange={event => setChain(event.target.value)}>
        <option value="solana:mainnet">Solana</option><option value="eip155:1">Ethereum</option><option value="eip155:8453">Base</option>
      </select></label>
      <label className="min-w-64 flex-1 space-y-2">Wallet address<input required value={address} onChange={event => setAddress(event.target.value)} className="block w-full rounded border border-white/20 bg-ink-deep p-3" autoComplete="off" /></label>
      <button disabled={loading} className="rounded bg-accent-bright px-5 py-3 text-black disabled:opacity-50">{loading ? "Loading…" : "Explore"}</button>
    </form>
    {error && <p role="alert" className="text-amber-300">{error}</p>}
    {history && <section className="space-y-4 rounded border border-white/10 p-5">
      <h2 className="text-xl">Observed transactions</h2><p className="break-all text-sm">{history.wallet}</p>
      <p className="text-sm text-muted-foreground">{history.coverage ? `Indexed range: ${history.coverage.start_height} through ${BigInt(history.coverage.next_height) - 1n}.` : "This chain has no indexed coverage yet."}</p>
      {history.transactions.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Transaction</th><th className="p-2">Block / slot</th><th className="p-2">Execution</th></tr></thead><tbody>
        {history.transactions.map(tx => <tr key={tx.tx_id} className="border-t border-white/10"><td className="max-w-96 break-all p-2 font-mono">{tx.tx_id}</td><td className="p-2">{tx.height}</td><td className="p-2">{tx.success === null ? "Unknown" : tx.success ? "Succeeded" : "Failed"}</td></tr>)}
      </tbody></table></div> : <p>No activity was found in the indexed range. This does not establish that the wallet has never been used.</p>}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{history.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      {history.nextCursor && <button disabled={loading} onClick={() => void load(true)} className="rounded border border-white/20 px-4 py-2">Load more</button>}
    </section>}
    {reputation && <section className="space-y-3 rounded border border-white/10 p-5"><h2 className="text-xl">Reviewed reputation evidence</h2>
      <p>{reputation.status.replaceAll("_", " ").toLowerCase()}</p><p className="text-sm text-muted-foreground">{reputation.reason}</p>
      {reputation.accepted.map(({ claim, reviewers }) => <div key={claim.id}><a className="underline" href={claim.sourceUrl} target="_blank" rel="noreferrer">{claim.label.replaceAll("_", " ")}</a><p className="text-sm">Reviewed by {reviewers.length} trusted reviewers.</p></div>)}
    </section>}
    {economics && <section className="space-y-3 rounded border border-white/10 p-5"><h2 className="text-xl">Your $AEX accounting</h2>
      <p className="text-2xl">{economics.balanceAtomic} internal units</p><p className="text-sm text-muted-foreground">{economics.explanation}</p>
      {economics.events.length ? <ul>{economics.events.map(event => <li key={event.event_key}>{event.direction === "CREDIT" ? "+" : "−"}{event.amount} · {event.purpose.replaceAll("_", " ")}</li>)}</ul> : <p>No accounting activity yet.</p>}
    </section>}
  </main>;
}
