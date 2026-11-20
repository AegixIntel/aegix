"use client";

import { useRef, useState } from "react";
import { API_BASE_URL } from "@/lib/api";
import { getSessionToken } from "@/lib/auth";

type Transaction = { tx_id: string; height: string; block_time: string | null; success: boolean | null; value_atomic: string | null };
type Cursor = { height: number; position: number };
type History = { wallet: string; coverage: { start_height: string; next_height: string } | null; transactions: Transaction[]; nextCursor: Cursor | null; limitations: string[] };
type Transfer = { tx_id: string; ordinal: number; height: string; kind: "NATIVE" | "ERC20" | "ERC721"; token: string | null;
  sender: string; recipient: string; amount_atomic: string | null; token_id: string | null; direction: "IN" | "OUT" | "SELF" };
type TransferCursor = Cursor & { ordinal: number };
type Transfers = { transfers: Transfer[]; nextCursor: TransferCursor | null; limitations: string[] };
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** Native amounts have 18 decimals on Ethereum and Base; token decimals are not known here. */
function nativeAmount(atomic: string) {
  const value = BigInt(atomic);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ETH`;
}
function describe(transfer: Transfer) {
  if (transfer.kind === "NATIVE") return nativeAmount(transfer.amount_atomic!);
  if (transfer.kind === "ERC721") return `NFT #${transfer.token_id} of ${short(transfer.token!)}`;
  return `${transfer.amount_atomic} units of ${short(transfer.token!)}`;
}
type Signals = {
  sample: { transfers: number; truncated: boolean; fromHeight: number | null; toHeight: number | null };
  activity: { incoming: number; outgoing: number; self: number; nativeIn: string; nativeOut: string; tokenContracts: number; zeroAmountIncoming: number };
  earliestFunding: { sender: string; height: number; tx_id: string; amount_atomic: string } | null;
  counterparties: Array<{ address: string; incoming: number; outgoing: number; nativeIn: string; nativeOut: string; firstHeight: number; lastHeight: number }>;
  lookAlikes: Array<{ address: string; imitates: string; tx_id: string; height: number; direction: "IN" | "OUT"; zeroAmount: boolean }>;
  limitations: string[];
};
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
  const [transfers, setTransfers] = useState<Transfers | null>(null);
  const [signals, setSignals] = useState<Signals | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const selection = useRef({ chain: "", address: "" });
  async function load(more = false) {
    const current = ++generation.current;
    const selected = more ? selection.current : { chain, address: address.trim() };
    const cursor = more ? history?.nextCursor : null;
    setLoading(true); setError("");
    if (!more) { setHistory(null); setReputation(null); setEconomics(null); setTransfers(null); setSignals(null); }
    const path = `${encodeURIComponent(selected.chain)}/${encodeURIComponent(selected.address)}`;
    try {
      const next = await read<History>(`/v1/network/history/${path}?limit=25${cursor ? `&beforeHeight=${cursor.height}&beforePosition=${cursor.position}` : ""}`);
      if (current !== generation.current) return;
      setHistory(previous => more && previous ? { ...next, transactions: [...previous.transactions, ...next.transactions] } : next);
      selection.current = selected;
      if (!more) {
        const evm = selected.chain.startsWith("eip155:");
        const [rep, aex, moved, observed] = await Promise.all([read<Reputation>(`/v1/network/reputation/${path}`), read<Economics>("/v1/me/aex", false),
          evm ? read<Transfers>(`/v1/network/transfers/${path}?limit=25`) : Promise.resolve(null),
          evm ? read<Signals>(`/v1/network/signals/${path}`) : Promise.resolve(null)]);
        if (current !== generation.current) return;
        setReputation(rep); setEconomics(aex); setTransfers(moved); setSignals(observed);
      }
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "Request failed"); }
    finally { if (current === generation.current) setLoading(false); }
  }
  async function moreTransfers() {
    const cursor = transfers?.nextCursor;
    if (!cursor) return;
    const current = ++generation.current;
    const { chain: selectedChain, address: selectedAddress } = selection.current;
    setLoading(true); setError("");
    try {
      const next = await read<Transfers>(`/v1/network/transfers/${encodeURIComponent(selectedChain)}/${encodeURIComponent(selectedAddress)}?limit=25`
        + `&beforeHeight=${cursor.height}&beforePosition=${cursor.position}&beforeOrdinal=${cursor.ordinal}`);
      if (current !== generation.current) return;
      setTransfers(previous => previous ? { ...next, transfers: [...previous.transfers, ...next.transfers] } : next);
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "Request failed"); }
    finally { if (current === generation.current) setLoading(false); }
  }
  return <main className="mx-auto max-w-6xl space-y-8 p-6 text-ink">
    <header><p className="section-label">Network intelligence</p><h1 className="mt-2 text-3xl">Explore indexed wallet activity</h1>
      <p className="mt-3 text-muted-foreground">Inspect observed activity and reviewed evidence across Solana, Ethereum and Base.</p></header>
    <form className="flex flex-wrap items-end gap-4" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label className="space-y-2">Chain<select className="block rounded border border-ink/20 bg-paper p-3" value={chain} onChange={event => setChain(event.target.value)}>
        <option value="solana:mainnet">Solana</option><option value="eip155:1">Ethereum</option><option value="eip155:8453">Base</option>
      </select></label>
      <label className="min-w-64 flex-1 space-y-2">Wallet address<input required value={address} onChange={event => setAddress(event.target.value)} className="block w-full rounded border border-ink/20 bg-paper p-3" autoComplete="off" /></label>
      <button disabled={loading} className="rounded bg-accent px-5 py-3 text-ink disabled:opacity-50">{loading ? "Loading…" : "Explore"}</button>
    </form>
    {error && <p role="alert" className="text-amber-800">{error}</p>}
    {history && <section className="space-y-4 rounded border border-ink/10 p-5">
      <h2 className="text-xl">Observed transactions</h2><p className="break-all text-sm">{history.wallet}</p>
      <p className="text-sm text-muted-foreground">{history.coverage ? `Indexed range: ${history.coverage.start_height} through ${BigInt(history.coverage.next_height) - 1n}.` : "This chain has no indexed coverage yet."}</p>
      {history.transactions.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Transaction</th><th className="p-2">Block / slot</th><th className="p-2">Execution</th></tr></thead><tbody>
        {history.transactions.map(tx => <tr key={tx.tx_id} className="border-t border-ink/10"><td className="max-w-96 break-all p-2 font-mono">{tx.tx_id}</td><td className="p-2">{tx.height}</td><td className="p-2">{tx.success === null ? "Unknown" : tx.success ? "Succeeded" : "Failed"}</td></tr>)}
      </tbody></table></div> : <p>No activity was found in the indexed range. This does not establish that the wallet has never been used.</p>}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{history.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      {history.nextCursor && <button disabled={loading} onClick={() => void load(true)} className="rounded border border-ink/20 px-4 py-2">Load more</button>}
    </section>}
    {signals && <section className="space-y-4 rounded border border-ink/10 p-5">
      <h2 className="text-xl">Wallet signals</h2>
      <p className="text-sm text-muted-foreground">Read from {signals.sample.transfers} observed transfers{signals.sample.fromHeight !== null ? `, blocks ${signals.sample.fromHeight} to ${signals.sample.toHeight}` : ""}. No score is given.</p>
      {signals.lookAlikes.length > 0 && <div role="alert" className="rounded border border-amber-600/40 bg-amber-50/40 p-4 text-sm">
        <p className="font-medium text-amber-900">Look-alike addresses found. Check every character before copying an address from history.</p>
        <ul className="mt-2 space-y-1">{signals.lookAlikes.map(l => <li key={`${l.tx_id}:${l.address}:${l.direction}`} className="break-all font-mono">
          {l.address} imitates {l.imitates} · {l.direction === "IN" ? "sent to this wallet" : "shown as sent by this wallet"}{l.zeroAmount ? " · zero amount" : ""} · block {l.height}</li>)}</ul>
      </div>}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Incoming</dt><dd>{signals.activity.incoming}</dd></div>
        <div><dt className="text-muted-foreground">Outgoing</dt><dd>{signals.activity.outgoing}</dd></div>
        <div><dt className="text-muted-foreground">ETH in / out</dt><dd>{nativeAmount(signals.activity.nativeIn)} / {nativeAmount(signals.activity.nativeOut)}</dd></div>
        <div><dt className="text-muted-foreground">Zero-amount token transfers received</dt><dd>{signals.activity.zeroAmountIncoming}</dd></div>
      </dl>
      {signals.earliestFunding && <p className="text-sm">Earliest observed funding: {nativeAmount(signals.earliestFunding.amount_atomic)} from <span className="break-all font-mono">{signals.earliestFunding.sender}</span> at block {signals.earliestFunding.height}.</p>}
      {signals.counterparties.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>
        <th className="p-2">Counterparty</th><th className="p-2">In</th><th className="p-2">Out</th><th className="p-2">Blocks</th></tr></thead><tbody>
        {signals.counterparties.map(c => <tr key={c.address} className="border-t border-ink/10"><td className="break-all p-2 font-mono">{c.address}</td>
          <td className="p-2">{c.incoming}</td><td className="p-2">{c.outgoing}</td><td className="p-2">{c.firstHeight === c.lastHeight ? c.firstHeight : `${c.firstHeight}–${c.lastHeight}`}</td></tr>)}
      </tbody></table></div>}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{signals.limitations.map(item => <li key={item}>{item}</li>)}</ul>
    </section>}
    {transfers && <section className="space-y-4 rounded border border-ink/10 p-5">
      <h2 className="text-xl">Observed transfers</h2>
      {transfers.transfers.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>
        <th className="p-2">Direction</th><th className="p-2">Amount</th><th className="p-2">Counterparty</th><th className="p-2">Block</th><th className="p-2">Transaction</th></tr></thead><tbody>
        {transfers.transfers.map(t => <tr key={`${t.tx_id}:${t.ordinal}`} className="border-t border-ink/10">
          <td className="p-2">{t.direction === "IN" ? "In" : t.direction === "OUT" ? "Out" : "Self"}</td>
          <td className="p-2">{describe(t)}</td>
          <td className="p-2 font-mono" title={t.direction === "IN" ? t.sender : t.recipient}>{short(t.direction === "IN" ? t.sender : t.recipient)}</td>
          <td className="p-2">{t.height}</td>
          <td className="p-2 font-mono" title={t.tx_id}>{short(t.tx_id)}</td></tr>)}
      </tbody></table></div> : <p>No transfers were found in the indexed range.</p>}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{transfers.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      {transfers.nextCursor && <button disabled={loading} onClick={() => void moreTransfers()} className="rounded border border-ink/20 px-4 py-2">Load more transfers</button>}
    </section>}
    {reputation && <section className="space-y-3 rounded border border-ink/10 p-5"><h2 className="text-xl">Reviewed reputation evidence</h2>
      <p>{reputation.status.replaceAll("_", " ").toLowerCase()}</p><p className="text-sm text-muted-foreground">{reputation.reason}</p>
      {reputation.accepted.map(({ claim, reviewers }) => <div key={claim.id}><a className="underline" href={claim.sourceUrl} target="_blank" rel="noreferrer">{claim.label.replaceAll("_", " ")}</a><p className="text-sm">Reviewed by {reviewers.length} trusted reviewers.</p></div>)}
    </section>}
    {economics && <section className="space-y-3 rounded border border-ink/10 p-5"><h2 className="text-xl">Your internal accounting (not $AGX)</h2>
      <p className="text-2xl">{economics.balanceAtomic} internal units</p><p className="text-sm text-muted-foreground">{economics.explanation}</p>
      {economics.events.length ? <ul>{economics.events.map(event => <li key={event.event_key}>{event.direction === "CREDIT" ? "+" : "−"}{event.amount} · {event.purpose.replaceAll("_", " ")}</li>)}</ul> : <p>No accounting activity yet.</p>}
    </section>}
  </main>;
}
