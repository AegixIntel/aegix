"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/developers", label: "API Keys", match: ["/developers", "/developers/api-keys"] },
  { href: "/developers/usage", label: "Usage", match: ["/developers/usage"] },
  { href: "/developers/webhooks", label: "Webhooks", match: ["/developers/webhooks"] }
];

export function DeveloperTabs() {
  const pathname = usePathname();
  return (
    <nav className="mt-6 flex gap-2 border-b border-ink/10" aria-label="Developer sections">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
            t.match.includes(pathname) ? "border-accent text-ink" : "border-transparent text-muted-foreground hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
