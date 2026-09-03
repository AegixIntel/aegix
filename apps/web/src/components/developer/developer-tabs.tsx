"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/developers", label: "API Keys" },
  { href: "/developers/usage", label: "Usage" },
  { href: "/developers/webhooks", label: "Webhooks" }
];

export function DeveloperTabs() {
  const pathname = usePathname();
  return (
    <nav className="mt-6 flex gap-2 border-b border-white/10" aria-label="Developer sections">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`-mb-px border-b-2 px-4 py-2 text-sm transition ${
            pathname === t.href ? "border-accent text-marble" : "border-transparent text-muted-foreground hover:text-marble"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
