"use client";

import Link from "next/link";
import { useState } from "react";
import { AegixLogo } from "@/components/aegix-logo";
import { NavDropdown, MobileNavGroup } from "@/components/layout/nav-dropdown";
import { primaryNav, docsNavLink, roadmapNavLink } from "@/lib/site";

export function PublicNavbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-ink-deep/85 backdrop-blur-md">
      <nav className="container-page flex h-16 items-center justify-between gap-4" aria-label="Primary">
        <Link href="/" className="flex items-center gap-3" aria-label="AEGIX home">
          <AegixLogo />
          <span className="hidden text-[10px] uppercase tracking-[0.2em] text-muted-2 lg:block">
            Financial &amp; On-Chain Intelligence
          </span>
        </Link>

        <div className="hidden items-center gap-6 md:flex">
          {primaryNav.map((group) => (
            <NavDropdown key={group.label} group={group} />
          ))}
          <Link href={docsNavLink.href} className="text-sm text-muted-foreground transition hover:text-marble">
            {docsNavLink.label}
          </Link>
          <Link href={roadmapNavLink.href} className="text-sm text-muted-foreground transition hover:text-marble">
            {roadmapNavLink.label}
          </Link>
        </div>

        <div className="hidden md:block">
          <Link href="/app/analyze" className="btn-primary px-4 py-2">
            Launch App <span className="text-white/70">→</span>
          </Link>
        </div>

        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-marble md:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label="Toggle navigation menu"
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </nav>

      {open && (
        <div id="mobile-nav" className="border-t border-white/10 bg-ink-deep md:hidden">
          <div className="container-page flex flex-col gap-1 py-4">
            {primaryNav.map((group) => (
              <MobileNavGroup key={group.label} group={group} onNavigate={() => setOpen(false)} />
            ))}
            <Link href={docsNavLink.href} onClick={() => setOpen(false)} className="rounded px-3 py-2 text-sm text-muted-foreground hover:text-marble">
              {docsNavLink.label}
            </Link>
            <Link href={roadmapNavLink.href} onClick={() => setOpen(false)} className="rounded px-3 py-2 text-sm text-muted-foreground hover:text-marble">
              {roadmapNavLink.label}
            </Link>
            <Link href="/app/analyze" onClick={() => setOpen(false)} className="btn-primary mt-2 justify-center">
              Launch App →
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
