import Link from "next/link";
import { PublicNavbar } from "@/components/layout/public-navbar";
import { PublicFooter } from "@/components/layout/public-footer";

const DOC_SECTIONS = [
  {
    title: "Getting Started",
    links: [
      { label: "What is AEGIX?", href: "/docs" },
      { label: "Quick Start", href: "/docs/quick-start" },
      { label: "Wallet Authentication", href: "/docs/authentication" }
    ]
  },
  {
    title: "Product",
    links: [
      { label: "Wallet X-Ray", href: "/docs/wallet-x-ray" },
      { label: "Privacy Exposure Score", href: "/docs/exposure-score" },
      { label: "Attack My Wallet", href: "/docs/attack-my-wallet" },
      { label: "Compare Wallets", href: "/docs/compare" },
      { label: "Privacy Monitor", href: "/docs/monitor" }
    ]
  },
  {
    title: "Intelligence",
    links: [
      { label: "Funding Provenance", href: "/docs/intelligence/funding" },
      { label: "Behavioral Similarity", href: "/docs/intelligence/behavior" },
      { label: "Temporal Correlation", href: "/docs/intelligence/temporal" },
      { label: "Entity Intelligence", href: "/docs/intelligence/entities" },
      { label: "Relationship Graph", href: "/docs/intelligence/graph" },
      { label: "Cluster Hypothesis", href: "/docs/intelligence/clusters" },
      { label: "Population Commonality", href: "/docs/intelligence/commonality" }
    ]
  },
  {
    title: "Methodology",
    links: [
      { label: "Signals", href: "/docs/methodology/signals" },
      { label: "Evidence", href: "/docs/methodology/evidence" },
      { label: "Correlation", href: "/docs/methodology/correlation" },
      { label: "Confidence", href: "/docs/methodology/confidence" },
      { label: "Data Quality", href: "/docs/methodology/data-quality" },
      { label: "Semantic Coverage", href: "/docs/methodology/semantic-coverage" },
      { label: "Limitations", href: "/docs/methodology/limitations" }
    ]
  },
  {
    title: "Developer API",
    links: [
      { label: "Overview", href: "/docs/api/overview" },
      { label: "Authentication", href: "/docs/api/authentication" },
      { label: "API Keys", href: "/docs/api/api-keys" },
      { label: "Scopes", href: "/docs/api/scopes" },
      { label: "Rate Limits", href: "/docs/api/rate-limits" },
      { label: "Quotas", href: "/docs/api/quotas" },
      { label: "Wallet Intelligence", href: "/docs/api/wallet-intelligence" },
      { label: "Compare Intelligence", href: "/docs/api/compare-intelligence" },
      { label: "Errors", href: "/docs/api/errors" }
    ]
  },
  {
    title: "Webhooks",
    links: [
      { label: "Overview", href: "/docs/webhooks" },
      { label: "Events", href: "/docs/webhooks/events" },
      { label: "Signatures", href: "/docs/webhooks/signatures" },
      { label: "Verification", href: "/docs/webhooks/verification" },
      { label: "Retries", href: "/docs/webhooks/retries" },
      { label: "Idempotency", href: "/docs/webhooks/idempotency" }
    ]
  },
  {
    title: "Security",
    links: [
      { label: "Wallet Authentication", href: "/docs/security/wallet-auth" },
      { label: "Sessions", href: "/docs/security/sessions" },
      { label: "Privacy Model", href: "/docs/security/privacy-model" }
    ]
  }
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-ink-deep">
      <PublicNavbar />
      <div className="flex flex-1">
        <aside className="hidden w-64 flex-none border-r border-white/10 bg-ink-deep lg:block">
          <nav className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-4 py-6" aria-label="Documentation">
            {DOC_SECTIONS.map((section) => (
              <div key={section.title} className="mb-6">
                <p className="section-label px-2 pb-2">
                  {section.title}
                </p>
                <ul className="space-y-1">
                  {section.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="block rounded-md px-2 py-1.5 text-sm text-muted-foreground transition hover:bg-white/5 hover:text-marble"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <div className="min-w-0 flex-1">
          <main className="container-narrow py-12">{children}</main>
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}
