"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listNotifications, markNotificationRead, type Notification } from "@/lib/api";
import NotificationEmailSettings from "@/components/notification-email";

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
    <div className="container-page max-w-3xl py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/app/dashboard" className="text-xs text-muted-foreground hover:text-accent">← Dashboard</Link>
          <h1 className="mt-1 font-display text-2xl font-semibold text-marble">Notifications</h1>
          <p className="text-sm text-muted-foreground">{unread} unread</p>
        </div>
      </header>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <div className="mt-6">
        <NotificationEmailSettings />
      </div>

      {notifications === null && !error ? (
        <p className="mt-10 text-center text-muted-foreground">Loading…</p>
      ) : notifications?.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-10 text-center">
          <p className="text-sm text-muted-foreground">No notifications yet.</p>
          <p className="text-xs text-muted-foreground/70">Enable monitoring on a saved wallet to start receiving alerts.</p>
          <Link href="/app/monitors" className="btn-primary mt-2 px-5 py-2.5 text-xs">Go to Monitors</Link>
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {notifications?.map((n) => (
            <div
              key={n.id}
              className={`card-surface p-4 ${n.read_at ? "opacity-60" : ""}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-sm font-semibold ${n.read_at ? "text-muted-foreground" : "text-marble"}`}>{n.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {n.channel} · {new Date(n.created_at).toLocaleString()}
                  </p>
                  {n.monitor_id && <p className="mt-0.5 text-[11px] text-muted-foreground/70">Monitor {shortAddress(n.monitor_id)}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${severityColor(n.severity)}`}>{n.severity}</span>
                  {!n.read_at && (
                    <button
                      onClick={() => void read(n.id)}
                      className="rounded border border-slate-600 px-2 py-0.5 text-[10px] text-muted-foreground hover:border-accent"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
