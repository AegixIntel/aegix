"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  testWebhook,
  type Webhook
} from "@/lib/api";

const EVENT_OPTIONS = [
  "analysis.completed",
  "comparison.completed",
  "monitor.alert",
  "notification.created"
];

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function shortUrl(url: string): string {
  return url.length > 60 ? `${url.slice(0, 57)}…` : url;
}

export default function WebhooksSection() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create form
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<string[]>(["analysis.completed"]);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = useState<{ id: string; secret: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const h = await listWebhooks();
      setHooks(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
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
      const created = await createWebhook(url.trim(), eventTypes);
      setCreatedSecret(created.secret);
      setUrl("");
      setEventTypes(["analysis.completed"]);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(hook: Webhook) {
    setBusy(true);
    try {
      await updateWebhook(hook.id, { status: hook.status === "ACTIVE" ? "DISABLED" : "ACTIVE" });
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteWebhook(id);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setBusy(true);
    setError(null);
    try {
      const data = await rotateWebhookSecret(id);
      setRotatedSecret(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rotate failed");
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setBusy(true);
    setError(null);
    try {
      await testWebhook(id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-8">
      {/* Create */}
      <section>
        <h2 className="text-lg font-semibold text-marble">Create Webhook</h2>
        <form onSubmit={(e) => void create(e)} className="card-surface mt-4 p-5">
          <label className="block text-xs text-muted-foreground">
            Endpoint URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              maxLength={500}
              required
              placeholder="https://your-app.com/webhooks/aegix"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-marble outline-none focus:border-accent"
            />
          </label>
          <fieldset className="mt-4">
            <legend className="text-xs text-muted-foreground">Events</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {EVENT_OPTIONS.map((ev) => (
                <label key={ev} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={eventTypes.includes(ev)}
                    onChange={(e) => {
                      setEventTypes((cur) => (e.target.checked ? [...new Set([...cur, ev])] : cur.filter((x) => x !== ev)));
                    }}
                    className="accent-accent"
                  />
                  <span className="font-mono text-xs">{ev}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="submit" disabled={busy || !url.trim() || eventTypes.length === 0} className="btn-primary mt-4 px-5 py-2 text-xs">
            {busy ? "Creating…" : "Create webhook"}
          </button>
        </form>
      </section>

      {/* One-time secret */}
      {createdSecret && (
        <section className="card-surface border-emerald-500/40 bg-emerald-950/30 p-5">
          <h2 className="text-sm font-semibold text-emerald-300">Webhook created — signing secret (shown once)</h2>
          <p className="mt-1 text-xs text-amber-300">Store this secret. AEGIX signs each delivery; verify it as documented. It cannot be retrieved again.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-xs text-emerald-200">{createdSecret}</code>
          <button
            onClick={() => void navigator.clipboard?.writeText(createdSecret)}
            className="mt-3 rounded-lg border border-emerald-500/40 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            Copy
          </button>
          <button onClick={() => setCreatedSecret(null)} className="ml-2 mt-3 rounded-lg border border-slate-600 px-4 py-2 text-xs text-muted-foreground hover:border-accent">
            Done
          </button>
          <p className="mt-3 text-xs text-muted-foreground">
            <Link href="/docs" className="underline">Read webhook signature verification docs →</Link>
          </p>
        </section>
      )}

      {rotatedSecret && (
        <section className="card-surface border-emerald-500/40 bg-emerald-950/30 p-5">
          <h2 className="text-sm font-semibold text-emerald-300">Secret rotated — old secret stopped working</h2>
          <p className="mt-1 text-xs text-amber-300">This new secret will only be shown once.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-xs text-emerald-200">{rotatedSecret.secret}</code>
          <button
            onClick={() => void navigator.clipboard?.writeText(rotatedSecret.secret)}
            className="mt-3 rounded-lg border border-emerald-500/40 px-4 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            Copy
          </button>
          <button onClick={() => setRotatedSecret(null)} className="ml-2 mt-3 rounded-lg border border-slate-600 px-4 py-2 text-xs text-muted-foreground hover:border-accent">
            Done
          </button>
        </section>
      )}

      {/* List */}
      <section>
        <h2 className="text-lg font-semibold text-marble">Webhooks</h2>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        {hooks === null && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : hooks?.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center text-sm text-muted-foreground">
            No webhooks yet. Create one above.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {hooks?.map((hook) => (
              <div key={hook.id} className="card-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm text-marble">{shortUrl(hook.url)}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>Events: {hook.eventTypes.length ? hook.eventTypes.join(", ") : "none"}</span>
                      <span>Created {shortDate(hook.createdAt)}</span>
                    </div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${hook.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-400" : "bg-slate-600/10 text-slate-400"}`}>
                    {hook.status}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs text-muted-foreground sm:grid-cols-4">
                  <div><p className="text-muted-foreground/60">Last success</p><p>{shortDate(hook.lastSuccessAt)}</p></div>
                  <div><p className="text-muted-foreground/60">Last failure</p><p>{shortDate(hook.lastFailureAt)}</p></div>
                  <div><p className="text-muted-foreground/60">Failures</p><p>{hook.failureCount}</p></div>
                  <div><p className="text-muted-foreground/60">Signing secret</p><p>Hidden</p></div>
                </div>

                {hook.disabledAt && (
                  <p className="mt-2 text-xs text-amber-300">Disabled {shortDate(hook.disabledAt)} — {hook.disabledReason ?? "reason unknown"}</p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button onClick={() => void test(hook.id)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">
                    Test
                  </button>
                  <button onClick={() => void rotate(hook.id)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">
                    Rotate secret
                  </button>
                  <button onClick={() => void toggleStatus(hook)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">
                    {hook.status === "ACTIVE" ? "Disable" : "Re-enable"}
                  </button>
                  <button onClick={() => void remove(hook.id)} disabled={busy} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-40">
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
