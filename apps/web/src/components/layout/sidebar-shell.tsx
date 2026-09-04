"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AegixLogo } from "@/components/aegix-logo";
import WalletAuthButton from "@/components/wallet-auth-button";
import { primaryNav, docsNavLink, roadmapNavLink, siteMenu } from "@/lib/site";

function SidebarLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={`flex items-center justify-between rounded-sm px-3 py-1.5 text-sm transition ${
        active ? "text-marble" : "text-muted-foreground hover:text-marble"
      }`}
    >
      <span>{label}</span>
      {active && <span className="h-1 w-1 rounded-full bg-accent-bright" aria-hidden="true" />}
    </Link>
  );
}

export function SidebarShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Docs has its own sidebar navigation; hide the site sidebar to avoid
  // two stacked left columns on /docs.
  const hideSiteSidebar = pathname.startsWith("/docs");

  return (
    <div className="flex min-h-screen flex-col bg-ink-deep">
      {/* Top bar */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-ink-deep/85 backdrop-blur-md">
        <nav className="flex h-14 items-center justify-between gap-4 px-4 lg:px-6" aria-label="Primary">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-marble lg:hidden"
              aria-expanded={open}
              aria-controls="site-sidebar"
              aria-label="Toggle menu"
              onClick={() => setOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                {open ? <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /> : <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />}
              </svg>
            </button>
            <Link href="/" className="flex items-center gap-2.5" aria-label="AEGIX home">
              <AegixLogo className="h-6" />
            </Link>
          </div>

          <div className="hidden items-center gap-6 lg:flex">
            {primaryNav.map((group) => (
              <span key={group.label} className="text-sm text-muted-foreground">{group.label}</span>
            ))}
            <Link href={docsNavLink.href} className="text-sm text-muted-foreground hover:text-marble">{docsNavLink.label}</Link>
            <Link href={roadmapNavLink.href} className="text-sm text-muted-foreground hover:text-marble">{roadmapNavLink.label}</Link>
          </div>

          <div className="flex items-center gap-2">
            <WalletAuthButton compact />
            <Link href="/app/analyze" className="btn-primary hidden px-4 py-2 sm:inline-flex">
              Launch App <span className="text-white/70">→</span>
            </Link>
          </div>
        </nav>
      </header>

      <div className="flex flex-1">
        {/* Left sidebar */}
        {!hideSiteSidebar && (
        <aside className="hidden w-56 flex-none border-r border-white/10 lg:block">
          <nav className="sticky top-14 px-3 py-6" aria-label="Site">
            <p className="section-label px-3 pb-2">Explore</p>
            <div className="space-y-0.5">
              {siteMenu.map((item) => (
                <SidebarLink key={item.href} href={item.href} label={item.label} />
              ))}
            </div>
          </nav>
        </aside>
        )}

        {/* Mobile sidebar */}
        {open && !hideSiteSidebar && (
          <div id="site-sidebar" className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} aria-hidden="true" />
            <div className="absolute left-0 top-0 h-full w-64 border-r border-white/10 bg-ink-deep p-4">
              <p className="section-label px-3 pb-2">Explore</p>
              <div className="space-y-0.5">
                {siteMenu.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="block rounded-sm px-3 py-2 text-sm text-muted-foreground hover:bg-white/5 hover:text-marble"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
