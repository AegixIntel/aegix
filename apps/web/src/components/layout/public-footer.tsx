import Link from "next/link";
import { AegixMark } from "@/components/aegix-logo";
import { footerColumns, LEGAL_ENTITY, legalLinks, SITE_URL } from "@/lib/site";

function FooterColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <h3 className="section-label mb-4">{title}</h3>
      <ul className="space-y-2">
        {links.map((link) => (
          <li key={`${title}-${link.label}`}>
            <Link href={link.href} className="text-sm text-muted-foreground transition hover:text-ink">
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
    <footer className="border-t border-ink/10 bg-paper">
      <div className="container-page py-16">
        <div className="grid gap-10 md:grid-cols-6">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 text-ink">
              <AegixMark className="h-7 w-7" />
              <span className="font-display text-xl font-semibold tracking-tight">AEGIX</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">Financial &amp; On-Chain Intelligence.</p>
            <p className="mt-1 font-display text-lg font-semibold text-ink">See What Others Don't.</p>
            <p className="mt-4 text-xs leading-relaxed text-muted-2">
              Correlation ≠ Ownership ≠ Identity. AEGIX reports observable relationships and confidence — it
              never asserts real-world identity.
            </p>
          </div>

          {footerColumns.map((col) => (
            <div key={col.title} className="md:col-span-1">
              <FooterColumn title={col.title} links={col.links} />
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-ink/10 pt-6 text-xs text-muted-2 sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} {LEGAL_ENTITY}. All rights reserved.</span>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-2">
            {legalLinks.map((link) => (
              <Link key={link.href} href={link.href} className="transition hover:text-ink">
                {link.label}
              </Link>
            ))}
          </nav>
          <span className="mono-address">{SITE_URL.replace(/^https?:\/\//, "")}</span>
        </div>
      </div>
    </footer>
  );
}
