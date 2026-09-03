import Link from "next/link";

export function DocBreadcrumb({ route }: { route: string }) {
  return (
    <p className="mb-6 text-xs text-muted-foreground">
      <Link href="/docs" className="hover:text-marble">Docs</Link>
      <span className="mx-1 text-muted-foreground/50">/</span>
      <span className="text-muted-foreground/80">{route}</span>
    </p>
  );
}

export function DocHeading({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }) {
  return (
    <header className="mb-8">
      <p className="section-label">{eyebrow}</p>
      <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-marble md:text-5xl">{title}</h1>
      {lead && <p className="mt-5 editorial-body max-w-2xl">{lead}</p>}
    </header>
  );
}

export function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-xl font-semibold text-marble">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export function DocList({ items }: { items: string[] }) {
  return (
    <ul className="ml-4 list-disc space-y-2 text-sm leading-relaxed text-muted-foreground">
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

export function DocCode({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-md border border-white/10 bg-black/40 p-4 font-mono text-[13px] leading-relaxed text-marble/90">
      <code>{children}</code>
    </pre>
  );
}

export function DocNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-950/20 p-4 text-xs leading-relaxed text-amber-200/90">
      {children}
    </div>
  );
}
