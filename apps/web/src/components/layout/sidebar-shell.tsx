"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AegixLogo } from "@/components/aegix-logo";
import WalletAuthButton from "@/components/wallet-auth-button";
import { cn } from "@/lib/cn";
import { primaryNav, docsNavLink, roadmapNavLink, siteMenu, siteRail } from "@/lib/site";

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

function RailStop({ href, label, status }: { href: string; label: string; status?: string }) {
  const pathname = usePathname();
  const active = pathname.startsWith(href);
  const live = status === "LIVE";

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full items-baseline justify-between gap-2 px-2 py-3 text-left transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-bright",
        active && "bg-white/5"
      )}
    >
      <span
        className={cn(
          "absolute -left-[21px] top-1/2 h-3 w-3 -translate-y-1/2",
          live ? "rail-signal bg-accent-bright" : "bg-muted-2"
        )}
        style={{ clipPath: "polygon(0 0, 100% 50%, 0 100%)" }}
        aria-hidden="true"
      />
      <span className={cn("font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-marble", !live && "text-muted-foreground")}>
        {label}
      </span>
      <span className={cn("font-display text-[9px] font-semibold uppercase tracking-[0.08em]", live ? "text-accent-bright" : "text-muted-2")}>
        {status}
      </span>
    </Link>
  );
}

/** Nav link with an animated underline on hover. */
function NavUnderline({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="group relative text-sm text-muted-foreground transition hover:text-marble">
      {children}
      <span
        className="absolute -bottom-0.5 left-0 h-px w-full origin-left scale-x-0 bg-accent-bright transition-transform duration-200 group-hover:scale-x-100"
        aria-hidden="true"
      />
    </Link>
  );
}

export function SidebarShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  // Docs has its own sidebar navigation; hide the site sidebar to avoid
  // two stacked left columns on /docs.
  const hideSiteSidebar = pathname.startsWith("/docs");

  // Soften the top bar once the page is scrolled (keeps it readable over
  // content). Uses a passive scroll listener; no per-frame state churn.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="site-shell flex min-h-screen flex-col bg-ink-deep">
      {/* Top bar */}
      <header
        className={cn(
          "sticky top-0 z-50 transition-colors duration-300",
          scrolled
            ? "border-b border-white/10 bg-ink-deep/90 backdrop-blur-md"
            : "border-b border-transparent bg-transparent"
        )}
      >
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
            <NavUnderline href={docsNavLink.href}>{docsNavLink.label}</NavUnderline>
            <NavUnderline href={roadmapNavLink.href}>{roadmapNavLink.label}</NavUnderline>
          </div>

          <div className="flex items-center gap-2">
            <WalletAuthButton compact buttonClassName="w-[9.5rem]" />
            <Link href="/app/analyze" className="btn-primary hidden w-[9.5rem] px-4 py-2 text-sm sm:inline-flex">
              Launch App <span className="btn-arrow text-inherit">→</span>
            </Link>
          </div>
        </nav>
      </header>

      <div className="flex flex-1">
        {/* Left sidebar */}
        {!hideSiteSidebar && (
        <aside className="hidden min-h-[calc(100vh-3.5rem)] w-[248px] flex-none border-r border-white/10 lg:block">
          <nav className="sticky top-14 flex h-[calc(100vh-3.5rem)] flex-col overflow-y-auto px-5 pb-[18px] pt-[22px]" aria-label="The Line">
            <div className="flex min-h-0 flex-1 flex-col">
              <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-2">The Line</p>
              <div className="relative mt-2 flex min-h-0 flex-1 flex-col justify-evenly pl-[22px] before:absolute before:bottom-[14px] before:left-[6px] before:top-[14px] before:w-0.5 before:bg-marble">
                {siteRail.map((item) => (
                  <RailStop key={item.href} href={item.href} label={item.label} status={item.status} />
                ))}
              </div>
            </div>
            <div className="mt-5 border-t border-white/10 pt-3.5">
              <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted-2">The Intelligence Layer</p>
              <p className="mt-1 text-[10.5px] leading-[1.35] text-muted-2">
                Activity → evidence → signals → intelligence.
              </p>
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
