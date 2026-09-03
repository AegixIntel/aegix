"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listDeveloperKeys,
  createDeveloperKey,
  revokeDeveloperKey,
  rotateDeveloperKey,
  type DeveloperApiKey,
  type CreatedDeveloperKey
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

export default function ApiKeysSection() {
  const [keys, setKeys] = useState<DeveloperApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["intelligence:read"]);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [created, setCreated] = useState<CreatedDeveloperKey | null>(null);
  const [busy, setBusy] = useState(false);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rotated, setRotated] = useState<CreatedDeveloperKey | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const k = await listDeveloperKeys();
      setKeys(k);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load developer data");
    }
  }, []);

  useEffect(() => {
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
    <div className="space-y-8">
      {/* Create key */}
      <section>
        <h2 className="text-lg font-semibold text-marble">Create API Key</h2>
        <form onSubmit={(e) => void create(e)} className="card-surface mt-4 p-5">
          <label className="block text-xs text-muted-foreground">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder="e.g. production integration"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
            />
          </label>
          <fieldset className="mt-4">
            <legend className="text-xs text-muted-foreground">Scopes</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {Object.entries(SCOPE_LABELS).map(([scope, label]) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) => {
                      setScopes((cur) => (e.target.checked ? [...new Set([...cur, scope])] : cur.filter((s) => s !== scope)));
                    }}
                    className="accent-accent"
                  />
                  <span className="font-mono text-xs">{scope}</span>
                  <span className="text-xs text-muted-foreground/70">({label})</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-4 block text-xs text-muted-foreground">
            Expiration (optional, days)
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays ?? ""}
              onChange={(e) => setExpiresInDays(e.target.value ? Number(e.target.value) : null)}
              placeholder="no expiration"
              className="mt-1 w-40 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim() || scopes.length === 0}
            className="btn-primary mt-4 px-5 py-2 text-xs"
          >
            {busy ? "Creating…" : "Create key"}
          </button>
        </form>
      </section>

      {/* One-time secret display */}
      {created && (
        <section className="card-surface border-emerald-500/40 bg-emerald-950/30 p-5">
          <h2 className="text-sm font-semibold text-emerald-300">Key created — copy it now</h2>
          <p className="mt-1 text-xs text-amber-300">This key will only be shown once. There is no way to retrieve it later.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-sm text-emerald-200">{created.key}</code>
          <button
            onClick={() => void navigator.clipboard?.writeText(created.key)}
            className="mt-3 rounded-lg border border-emerald-500/40 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            Copy
          </button>
          <button onClick={() => setCreated(null)} className="ml-2 mt-3 rounded-lg border border-slate-600 px-4 py-2 text-xs text-muted-foreground hover:border-accent">
            Done
          </button>
        </section>
      )}

      {rotated && (
        <section className="card-surface border-emerald-500/40 bg-emerald-950/30 p-5">
          <h2 className="text-sm font-semibold text-emerald-300">Key rotated — the old key stopped working</h2>
          <p className="mt-1 text-xs text-amber-300">This new key will only be shown once.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-sm text-emerald-200">{rotated.key}</code>
          <button
            onClick={() => void navigator.clipboard?.writeText(rotated.key)}
            className="mt-3 rounded-lg border border-emerald-500/40 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            Copy
          </button>
          <button onClick={() => setRotated(null)} className="ml-2 mt-3 rounded-lg border border-slate-600 px-4 py-2 text-xs text-muted-foreground hover:border-accent">
            Done
          </button>
        </section>
      )}

      {/* Key list */}
      <section>
        <h2 className="text-lg font-semibold text-marble">API Keys</h2>
        {keys === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : keys?.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center text-sm text-muted-foreground">
            No API keys yet. Create one above.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {keys?.map((k) => {
              const status = keyStatus(k);
              return (
                <div key={k.id} className="card-surface p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-marble">{k.name}</p>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">{k.key_prefix}…</p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-400" : status === "EXPIRED" ? "bg-amber-500/10 text-amber-400" : "bg-red-500/10 text-red-400"
                      }`}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
                        className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
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
                          <button onClick={() => setConfirmId(null)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-muted-foreground">
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
    </div>
  );
}
