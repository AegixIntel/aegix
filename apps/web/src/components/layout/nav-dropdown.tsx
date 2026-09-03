"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/primitives";
import type { NavGroup } from "@/lib/site";

/** Desktop dropdown menu item group. */
export function NavDropdown({ group }: { group: NavGroup }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1 py-1 text-sm text-muted-foreground transition hover:text-marble"
      >
        {group.label}
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 transition-transform" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 4l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-64 rounded-md border border-white/10 bg-ink-deep p-2 shadow-xl shadow-black/40">
          {group.items.map((item) => (
            <Link
              key={`${item.label}-${item.href}`}
              href={item.href}
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground transition hover:bg-white/5 hover:text-marble"
            >
              <span>{item.label}</span>
              {item.status && <StatusBadge label={item.status} />}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Mobile accordion groups. */
export function MobileNavGroup({ group, onNavigate }: { group: NavGroup; onNavigate: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded px-3 py-2 text-sm text-muted-foreground hover:text-marble"
      >
        {group.label}
        <svg viewBox="0 0 12 12" className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mb-1 space-y-0.5 border-l border-white/10 pl-3">
          {group.items.map((item) => (
            <Link
              key={`${item.label}-${item.href}`}
              href={item.href}
              onClick={onNavigate}
              className="flex items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-marble"
            >
              <span>{item.label}</span>
              {item.status && <StatusBadge label={item.status} />}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
