"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listDeveloperKeys,
  createDeveloperKey,
  revokeDeveloperKey,
  rotateDeveloperKey,
  getDeveloperUsage,
  type DeveloperApiKey,
  type CreatedDeveloperKey,
  type DeveloperUsageSummary
} from "@/lib/api";

const SCOPE_LABELS: Record<string, string> = {
  "intelligence:read": "Read wallet intelligence",
  "usage:read": "Read usage"
};

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function keyStatus(key: DeveloperApiKey): "ACTIVE" | "REVOKED" | "EXPIRED" {
  if (key.status !== "ACTIVE") return "REVOKED";
  if (key.expires_at && new Date(key.expires_at) < new Date()) return "EXPIRED";
  return "ACTIVE";
}

export default function DeveloperPage() {
  const [keys, setKeys] = useState<DeveloperApiKey[] | null>(null);
  const [usage, setUsage] = useState<DeveloperUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Create-key form
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["intelligence:read"]);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [created, setCreated] = useState<CreatedDeveloperKey | null>(null);
  const [busy, setBusy] = useState(false);

  // Revoke confirmation
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rotated, setRotated] = useState<CreatedDeveloperKey | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [k, u] = await Promise.all([listDeveloperKeys(), getDeveloperUsage()]);
      setKeys(k);
      setUsage(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load developer data");
    }
  }, []);

  useEffect(() => {
    const t = window.localStorage.getItem("aegix_access_token");
    setToken(t);
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const key = await createDeveloperKey(name.trim(), scopes, expiresInDays ?? undefined);
      setCreated(key);
      setName("");
      setScopes(["intelligence:read"]);
      setExpiresInDays(null);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await revokeDeveloperKey(id);
      setConfirmId(null);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const key = await rotateDeveloperKey(id);
      setRotated(key);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rotate failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a href="/dashboard" className="text-xs text-slate-500 hover:text-accent">← Dashboard</a>
          <h1 className="mt-1 text-2xl font-bold">Developer API</h1>
          <p className="text-sm text-slate-400">Manage API keys and usage for the AEGIX developer platform.</p>
        </div>
      </header>

      {!token && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-300">
          You are browsing anonymously.{" "}
          <a href="/?login=1" className="underline">Sign in</a> to create API keys.
        </div>
      )}

      {error && <p className="mt-6 text-sm text-red-400">{error}</p>}

      {/* Usage (D6-D §91) */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Usage</h2>
        {usage === null && !error ? (
          <p className="mt-4 text-sm text-slate-400">Loading…</p>
        ) : usage ? (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Used</p>
                <p className="mt-1 text-xl font-bold">{usage.used}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Limit</p>
                <p className="mt-1 text-xl font-bold">{usage.limit}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Remaining</p>
                <p className="mt-1 text-xl font-bold text-emerald-300">{usage.remaining}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">Resets</p>
                <p className="mt-1 text-sm font-semibold text-slate-300">{usage.resetAt ? new Date(usage.resetAt).toLocaleString() : "—"}</p>
              </div>
            </div>
            {usage.breakdown.length > 0 && (
              <div className="mt-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">By operation</p>
                <ul className="mt-2 space-y-1 text-sm text-slate-300">
                  {usage.breakdown.map((b) => (
                    <li key={b.operation} className="flex justify-between">
                      <span className="font-mono text-xs">{b.operation}</span>
                      <span>{b.units}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-4 text-xs text-slate-500">Quota is per user and resets daily at UTC midnight. Keys do not multiply quota.</p>
          </div>
        ) : null}
      </section>

      {/* Create key (D6-C §86) */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Create API Key</h2>
        <form onSubmit={(e) => void create(e)} className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
          <label className="block text-xs text-slate-500">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder="e.g. production integration"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
            />
          </label>
          <fieldset className="mt-4">
            <legend className="text-xs text-slate-500">Scopes</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {Object.entries(SCOPE_LABELS).map(([scope, label]) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) => {
                      setScopes((cur) => (e.target.checked ? [...new Set([...cur, scope])] : cur.filter((s) => s !== scope)));
                    }}
                    className="accent-accent"
                  />
                  <span className="font-mono text-xs">{scope}</span>
                  <span className="text-xs text-slate-500">({label})</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-4 block text-xs text-slate-500">
            Expiration (optional, days)
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays ?? ""}
              onChange={(e) => setExpiresInDays(e.target.value ? Number(e.target.value) : null)}
              placeholder="no expiration"
              className="mt-1 w-40 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-accent"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim() || scopes.length === 0}
            className="mt-4 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create key"}
          </button>
        </form>
      </section>

      {/* One-time secret display (D6-C §87) */}
      {created && (
        <section className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-4">
          <h2 className="text-sm font-semibold text-emerald-300">Key created — copy it now</h2>
          <p className="mt-1 text-xs text-amber-300">This key will only be shown once. There is no way to retrieve it later.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-sm text-emerald-200">{created.key}</code>
          <button
            onClick={() => void navigator.clipboard?.writeText(created.key)}
            className="mt-3 rounded-lg border border-emerald-500/40 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            Copy
          </button>
          <button onClick={() => setCreated(null)} className="ml-2 mt-3 rounded-lg border border-slate-600 px-4 py-2 text-xs text-slate-300 hover:border-accent">
            Done
          </button>
        </section>
      )}

      {rotated && (
        <section className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-4">
          <h2 className="text-sm font-semibold text-emerald-300">Key rotated — the old key stopped working</h2>
          <p className="mt-1 text-xs text-amber-300">This new key will only be shown once.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-sm text-emerald-200">{rotated.key}</code>
          <button
            onClick={() => void navigator.clipboard?.writeText(rotated.key)}
            className="mt-3 rounded-lg border border-emerald-500/40 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            Copy
          </button>
          <button onClick={() => setRotated(null)} className="ml-2 mt-3 rounded-lg border border-slate-600 px-4 py-2 text-xs text-slate-300 hover:border-accent">
            Done
          </button>
        </section>
      )}

      {/* Key list (D6-C §88) */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold">API Keys</h2>
        {keys === null && !error ? (
          <p className="mt-4 text-sm text-slate-400">Loading…</p>
        ) : keys?.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-6 text-center text-sm text-slate-400">
            No API keys yet. Create one above.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {keys?.map((k) => {
              const status = keyStatus(k);
              return (
                <div key={k.id} className="rounded-xl border border-slate-700 bg-slate-900 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-100">{k.name}</p>
                      <p className="mt-0.5 font-mono text-xs text-slate-500">{k.key_prefix}…</p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-400" : status === "EXPIRED" ? "bg-amber-500/10 text-amber-400" : "bg-red-500/10 text-red-400"
                      }`}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>
                      Scopes:{" "}
                      {k.scopes.map((s) => (
                        <code key={s} className="text-slate-400">{s}</code>
                      )).reduce<React.ReactNode[]>((acc, el, i) => (i === 0 ? [el] : [...acc, <span key={`sep-${i}`}>, </span>, el]), [])}
                    </span>
                    <span>Created {shortDate(k.created_at)}</span>
                    <span>Last used {shortDate(k.last_used_at)}</span>
                    <span>Expires {shortDate(k.expires_at)}</span>
                  </div>
                  {status === "ACTIVE" && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        onClick={() => void rotate(k.id)}
                        disabled={busy}
                        className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-accent disabled:opacity-40"
                      >
                        Rotate
                      </button>
                      {confirmId === k.id ? (
                        <span className="flex items-center gap-2">
                          <button
                            onClick={() => void revoke(k.id)}
                            disabled={busy}
                            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/30"
                          >
                            Confirm revoke
                          </button>
                          <button onClick={() => setConfirmId(null)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-400">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmId(k.id)}
                          className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* API status placeholder (D6-B §85) */}
      <section className="mt-8 rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs text-slate-500">
        <p><span className="font-semibold text-slate-300">API status:</span> developer endpoints are available at <code>/v1/developer</code>. Authenticate with <code>Authorization: Bearer &lt;api-key&gt;</code>. Keys must never be sent in URLs.</p>
      </section>
    </main>
  );
}
