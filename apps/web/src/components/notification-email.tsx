"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getNotificationEmail,
  setNotificationEmail,
  verifyNotificationEmail,
  deleteNotificationEmail,
  type NotificationEmailState
} from "@/lib/api";

export default function NotificationEmailSettings() {
  const [state, setState] = useState<NotificationEmailState | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getNotificationEmail();
      setState(s);
      setEmail(s.email ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load email settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await setNotificationEmail(email.trim());
      setState(s);
      setMessage("Verification code sent. Check your inbox.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Set email failed");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const s = await verifyNotificationEmail(code.trim());
      setState(s);
      setCode("");
      setMessage("Email verified. You are now eligible for email alerts.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const s = await deleteNotificationEmail();
      setState(s);
      setEmail("");
      setMessage("Email destination removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  }

  const pending = state?.verificationPending ?? false;
  const verified = state?.verified ?? false;

  return (
    <section className="card-surface p-5">
      <h2 className="text-sm font-semibold text-marble">Notification Email</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Optional destination for alert emails. Email is <span className="font-semibold text-marble/90">not authentication</span> — it only receives alerts you opt into.
      </p>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}

      <form onSubmit={(e) => void save(e)} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={254}
          placeholder="you@example.com"
          aria-label="Notification email"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
        />
        <button type="submit" disabled={busy || !email.trim()} className="btn-primary px-4 py-2 text-xs">
          {busy ? "Sending…" : pending ? "Resend code" : "Save email"}
        </button>
        {verified && (
          <button type="button" onClick={() => void remove()} disabled={busy} className="rounded-lg border border-red-500/40 px-4 py-2 text-xs text-red-400">
            Remove
          </button>
        )}
      </form>

      {pending && !verified && (
        <form onSubmit={(e) => void verify(e)} className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
            inputMode="numeric"
            placeholder="6-digit code"
            aria-label="Verification code"
            className="w-40 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-marble outline-none focus:border-accent"
          />
          <button type="submit" disabled={busy || code.trim().length !== 6} className="btn-secondary px-4 py-2 text-xs">
            Verify
          </button>
        </form>
      )}

      {!verified && !pending && (
        <p className="mt-3 text-xs text-muted-foreground/70">
          Deliverability depends on provider configuration. Verification codes expire after {15} minutes.
        </p>
      )}
    </section>
  );
}
