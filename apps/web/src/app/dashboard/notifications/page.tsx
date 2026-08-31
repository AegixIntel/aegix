"use client";

import { useCallback, useEffect, useState } from "react";
import { listNotifications, markNotificationRead, type Notification } from "@/lib/api";

function shortAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "CRITICAL": return "bg-red-500/15 text-red-400";
    case "HIGH": return "bg-orange-500/15 text-orange-400";
    case "MEDIUM": return "bg-amber-500/15 text-amber-400";
    case "LOW": return "bg-sky-500/15 text-sky-400";
    default: return "bg-slate-600/15 text-slate-400";
  }
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { notifications: items, unreadCount } = await listNotifications();
      setNotifications(items);
      setUnread(unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function read(id: string) {
    await markNotificationRead(id);
    setNotifications((cur) => (cur ?? []).map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <a href="/dashboard" className="text-xs text-slate-500 hover:text-accent">← Dashboard</a>
          <h1 className="mt-1 text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-slate-400">{unread} unread</p>
        </div>
      </header>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {notifications === null && !error ? (
        <p className="mt-10 text-center text-slate-400">Loading…</p>
      ) : notifications?.length === 0 ? (
        <div className="mt-10 rounded-xl border border-slate-700 bg-slate-900 p-8 text-center text-sm text-slate-400">
          No notifications yet. Enable monitoring on a saved wallet to start receiving alerts.
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {notifications?.map((n) => (
            <div
              key={n.id}
              className={`rounded-xl border p-4 ${n.read_at ? "border-slate-800 bg-slate-900/50" : "border-slate-700 bg-slate-900"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-sm font-semibold ${n.read_at ? "text-slate-400" : "text-slate-100"}`}>{n.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {n.channel} · {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${severityColor(n.severity)}`}>{n.severity}</span>
                  {!n.read_at && (
                    <button
                      onClick={() => void read(n.id)}
                      className="rounded border border-slate-600 px-2 py-0.5 text-[10px] text-slate-300 hover:border-accent"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-400">{n.body}</p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
