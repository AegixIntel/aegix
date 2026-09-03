import Link from "next/link";
import { AegixMark } from "@/components/aegix-logo";
import {
  footerProductLinks,
  footerDeveloperLinks,
  footerResearchLinks,
  footerCompanyLinks,
  SITE_URL
} from "@/lib/site";

function FooterColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h3>
      <ul className="mt-4 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-sm text-muted-foreground transition hover:text-marble">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-white/10 bg-ink-deep">
      <div className="container-page py-14">
        <div className="grid gap-10 md:grid-cols-5">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 text-marble">
              <AegixMark className="h-6 w-6" />
              <span className="font-display text-lg font-semibold">AEGIX</span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Evidence-based on-chain privacy intelligence for Solana. Built on observable data —
              never asserted identity.
            </p>
            <p className="mt-4 text-xs text-muted-foreground/70">
              Correlation ≠ Ownership ≠ Identity. The AEGIX observed population is not the global Solana population.
            </p>
          </div>

          <FooterColumn title="Product" links={footerProductLinks} />
          <FooterColumn title="Developers" links={footerDeveloperLinks} />
          <FooterColumn title="Research" links={footerResearchLinks} />
          <FooterColumn title="AEGIX" links={footerCompanyLinks} />
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-white/10 pt-6 text-xs text-muted-foreground/70 sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} AEGIX. All rights reserved.</span>
          <span className="mono-address">{SITE_URL.replace(/^https?:\/\//, "")}</span>
        </div>
      </div>
    </footer>
  );
}
