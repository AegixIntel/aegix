"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type Notification,
  type NotificationListOptions
} from "@/lib/api";

function shortAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "CRITICAL": return "bg-red-500/15 text-red-700";
    case "HIGH": return "bg-orange-500/15 text-orange-700";
    case "MEDIUM": return "bg-amber-500/15 text-amber-800";
    case "LOW": return "bg-sky-500/15 text-sky-700";
    default: return "bg-ink/[0.07] text-muted-foreground";
  }
}

type FilterSeverity = "" | "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterUnread, setFilterUnread] = useState(false);
  const [filterSeverity, setFilterSeverity] = useState<FilterSeverity>("");
  const [markingAll, setMarkingAll] = useState(false);
  const [readingIds, setReadingIds] = useState<Set<string>>(() => new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (cursorValue?: string) => {
    const sequence = ++requestSequence.current;
    controller.current?.abort();
    const currentController = new AbortController();
    controller.current = currentController;
    setError(null);
    if (cursorValue) setLoadingMore(true);
    else setLoading(true);
    try {
      const opts: NotificationListOptions = {
        limit: 20,
        unreadOnly: filterUnread || undefined,
        severity: filterSeverity || undefined,
        cursor: cursorValue,
        signal: currentController.signal
      };
      const { notifications: items, unreadCount, nextCursor: nc } = await listNotifications(opts);
      if (sequence !== requestSequence.current) return;
      setNotifications((prev) => {
        if (!cursorValue) return items;
        const byId = new Map(prev.map((item) => [item.id, item]));
        for (const item of items) byId.set(item.id, item);
        return [...byId.values()];
      });
      setUnread(unreadCount);
      setNextCursor(nc);
    } catch (err) {
      if (currentController.signal.aborted || sequence !== requestSequence.current) return;
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filterUnread, filterSeverity]);

  useEffect(() => {
    let disposed = false;
    const schedule = () => {
      if (disposed || document.visibilityState !== "visible") return;
      refreshTimer.current = setTimeout(async () => {
        await load();
        schedule();
      }, 60_000);
    };
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      await load();
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
      else {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        controller.current?.abort();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      controller.current?.abort();
    };
  }, [load]);

  async function read(id: string) {
    if (readingIds.has(id) || markingAll) return;
    const target = notifications.find((item) => item.id === id);
    if (!target || target.read_at) return;
    const prev = notifications;
    const prevUnread = unread;
    setReadingIds((ids) => new Set(ids).add(id));
    setNotifications((cur) => filterUnread ? cur.filter((n) => n.id !== id) : cur.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await markNotificationRead(id);
    } catch {
      setNotifications(prev);
      setUnread(prevUnread);
      setError("Failed to mark as read. Please try again.");
    } finally {
      setReadingIds((ids) => { const next = new Set(ids); next.delete(id); return next; });
    }
  }

  async function readAll() {
    setMarkingAll(true);
    const prevNotifs = notifications;
    const prevUnread = unread;
    setNotifications((cur) => filterUnread ? [] : cur.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      setNotifications(prevNotifs);
      setUnread(prevUnread);
      setError("Failed to mark all as read. Please try again.");
    } finally {
      setMarkingAll(false);
    }
  }

  const hasFilters = filterUnread || filterSeverity;

  return (
    <div className="container-page max-w-3xl py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/app/dashboard" className="text-xs text-muted-foreground hover:text-accent-ink">← Dashboard</Link>
          <h1 className="mt-1 font-display text-2xl font-semibold text-ink">Notifications</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">{unread} unread</p>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && (
            <button
              onClick={() => void readAll()}
              disabled={markingAll}
              className="rounded border border-ink/10 px-3 py-1.5 text-xs text-muted-foreground hover:border-accent hover:text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              aria-label="Mark all notifications as read"
            >
              {markingAll ? "Marking…" : "Mark all read"}
            </button>
          )}
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded border border-ink/10 px-3 py-1.5 text-xs text-muted-foreground hover:border-accent hover:text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            aria-label="Refresh notifications"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter notifications">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={filterUnread}
            onChange={(e) => setFilterUnread(e.target.checked)}
            className="accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          Unread only
        </label>
        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value as FilterSeverity)}
          className="rounded border border-ink/10 bg-ink/[0.03] px-2 py-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Filter by severity"
        >
          <option value="">All severities</option>
          <option value="CRITICAL">Critical</option>
          <option value="HIGH">High</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
          <option value="INFO">Info</option>
        </select>
        {hasFilters && (
          <button
            onClick={() => { setFilterUnread(false); setFilterSeverity(""); }}
            className="text-xs text-accent-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded border border-red-600/20 bg-red-500/5 p-3" role="alert">
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => { setError(null); void load(); }} className="ml-auto text-xs text-red-700 underline hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600">Retry</button>
        </div>
      )}

      {loading && notifications.length === 0 ? (
        <div className="mt-10 space-y-2" aria-label="Loading notifications">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card-surface animate-pulse p-4 motion-reduce:animate-none">
              <div className="h-4 w-2/3 rounded bg-ink/5" />
              <div className="mt-2 h-3 w-1/3 rounded bg-ink/5" />
            </div>
          ))}
        </div>
      ) : !loading && notifications.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-2 rounded-xl border border-dashed border-ink/10 bg-ink/[0.02] p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {hasFilters ? "No notifications match your filters." : "No notifications yet."}
          </p>
          <p className="text-xs text-muted-foreground/70">
            {hasFilters
              ? "Try adjusting your filters or check back later."
              : "Enable monitoring on a saved wallet to start receiving in-app alerts."}
          </p>
          {!hasFilters && (
            <Link href="/app/monitors" className="btn-primary mt-2 px-5 py-2.5 text-xs">Go to Monitors</Link>
          )}
        </div>
      ) : (
        <div className="mt-6 space-y-2">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`card-surface p-4 transition-opacity motion-reduce:transition-none ${n.read_at ? "opacity-60" : ""}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-sm font-semibold ${n.read_at ? "text-muted-foreground" : "text-ink"}`}>{n.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <span className="font-mono text-[10px]">IN_APP</span>
                    <span className="mx-1.5 opacity-30">·</span>
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                  {n.monitor_id && <p className="mt-0.5 text-[11px] text-muted-foreground/70">Monitor {shortAddress(n.monitor_id)}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${severityColor(n.severity)}`}>{n.severity}</span>
                  {!n.read_at && (
                    <button
                      onClick={() => void read(n.id)}
                      disabled={readingIds.has(n.id) || markingAll}
                      className="rounded border border-ink/20 px-2 py-0.5 text-[10px] text-muted-foreground hover:border-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                      aria-label={`Mark "${n.title}" as read`}
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{n.body}</p>
            </div>
          ))}
          {nextCursor && (
            <button
              onClick={() => void load(nextCursor)}
              disabled={loading || loadingMore}
              className="w-full rounded border border-ink/10 py-2 text-xs text-muted-foreground hover:border-accent hover:text-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
