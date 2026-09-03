"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { AegixMark } from "@/components/aegix-logo";
import { useAuth } from "@/components/auth-provider";
import WalletAuthButton from "@/components/wallet-auth-button";
import { appOverviewNav, appDeveloperNav } from "@/lib/site";
import type { AppNavItem } from "@/lib/site";

function NavLink({ item, active, onNavigate }: { item: AppNavItem; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition ${
        active ? "bg-accent/15 font-semibold text-marble" : "text-muted-foreground hover:bg-white/5 hover:text-marble"
      }`}
    >
      {item.label}
      {active && <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" aria-hidden="true" />}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-screen bg-ink-deep">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 flex-none border-r border-white/10 bg-ink-deep md:flex md:flex-col">
        <div className="flex h-16 items-center border-b border-white/10 px-5">
          <Link href="/" className="flex items-center gap-2 text-marble">
            <AegixMark className="h-6 w-6" />
            <span className="font-display text-lg font-semibold tracking-tight">AEGIX</span>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Application">
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Overview
          </p>
          <div className="space-y-1">
            {appOverviewNav.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} />
            ))}
          </div>

          <p className="px-3 pb-2 pt-6 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Developer
          </p>
          <div className="space-y-1">
            {appDeveloperNav.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} />
            ))}
          </div>
        </nav>

        <div className="border-t border-white/10 p-4">
          <div className="flex flex-col gap-3">
            <WalletAuthButton />
            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/70">
              {user ? `Connected: ${user.wallet ? `${user.wallet.slice(0, 6)}…${user.wallet.slice(-4)}` : "—"}` : "Connect wallet to save & monitor."}
            </p>
          </div>
        </div>
      </aside>

      {/* Mobile bar */}
      <div className="flex w-full flex-1 flex-col">
        <div className="flex h-16 items-center justify-between border-b border-white/10 bg-ink-deep px-4 md:hidden">
          <Link href="/" className="flex items-center gap-2 text-marble">
            <AegixMark className="h-6 w-6" />
            <span className="font-display text-base font-semibold">AEGIX</span>
          </Link>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-marble"
            aria-expanded={mobileOpen}
            aria-controls="mobile-app-nav"
            aria-label="Toggle application menu"
            onClick={() => setMobileOpen((v) => !v)}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              {mobileOpen ? <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /> : <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />}
            </svg>
          </button>
        </div>

        {mobileOpen && (
          <div id="mobile-app-nav" className="border-b border-white/10 bg-ink-deep md:hidden">
            <div className="space-y-1 px-4 py-4">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Overview</p>
              {appOverviewNav.map((item) => (
                <NavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={() => setMobileOpen(false)} />
              ))}
              <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">Developer</p>
              {appDeveloperNav.map((item) => (
                <NavLink key={item.href} item={item} active={isActive(item.href)} onNavigate={() => setMobileOpen(false)} />
              ))}
              <div className="mt-4 px-3">
                <WalletAuthButton />
              </div>
            </div>
          </div>
        )}

        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
