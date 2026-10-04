import Link from "next/link";
import { cn } from "@/lib/cn";

/** Small uppercase tracked label, optional numeric prefix and status suffix. */
export function SectionLabel({
  children,
  prefix,
  status,
  tone = "muted"
}: {
  children: React.ReactNode;
  prefix?: string;
  status?: string;
  tone?: "muted" | "accent";
}) {
  return (
    <div className="flex items-center gap-3">
      {prefix && <span className="section-label">{prefix}</span>}
      <span className={cn("section-label", tone === "accent" ? "section-label-accent" : "")}>{children}</span>
      {status && <StatusBadge label={status} />}
    </div>
  );
}

/** Large editorial statement heading (display font, responsive clamp). */
export function EditorialHeading({
  children,
  as: Tag = "h2",
  size = "md",
  className
}: {
  children: React.ReactNode;
  as?: "h1" | "h2" | "h3";
  size?: "md" | "lg";
  className?: string;
}) {
  return <Tag className={cn(size === "lg" ? "statement-lg" : "statement", className)}>{children}</Tag>;
}

/** Status badge — neutral by default, single accent for LIVE / ACTIVE. */
const STATUS_TONES: Record<string, string> = {
  LIVE: "text-accent-ink border-accent/40",
  ACTIVE: "text-accent-ink border-accent/40",
  READY: "text-emerald-800 border-emerald-600/30",
  VERIFIED: "text-emerald-800 border-emerald-600/30",
  SHIPPED: "text-emerald-800 border-emerald-600/30",
  "IN DEVELOPMENT": "text-amber-800 border-amber-600/30",
  CURRENT: "text-amber-800 border-amber-600/30",
  NEXT: "text-muted-foreground border-ink/15",
  PLANNED: "text-muted-foreground border-ink/15",
  LATER: "text-muted-2 border-ink/10",
  RESEARCH: "text-muted-foreground border-ink/15"
};

export function StatusBadge({ label, className }: { label: string; className?: string }) {
  const tone = STATUS_TONES[label.toUpperCase()] ?? "text-muted-foreground border-ink/15";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.12em]",
        tone,
        className
      )}
    >
      {label}
    </span>
  );
}

/** Inline arrow link with hover underline. */
export function InlineArrowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-1 text-sm font-medium text-ink decoration-ink/20 underline-offset-4 transition hover:text-ink hover:decoration-accent",
        className
      )}
    >
      <span className="underline decoration-transparent group-hover:underline">{children}</span>
      <span className="text-accent-ink transition-transform group-hover:translate-x-0.5">→</span>
    </Link>
  );
}

/** Numbered editorial row used for product presentation instead of cards. */
export function FeatureRow({
  index,
  title,
  body,
  detail,
  href,
  cta,
  className
}: {
  index: string;
  title: string;
  body: string;
  detail?: string[];
  href?: string;
  cta?: string;
  className?: string;
}) {
  return (
    <div className={cn("group grid gap-5 border-t border-ink/10 py-8 md:grid-cols-[3rem_1fr_1.2fr_auto]", className)}>
      <span className="font-mono text-sm text-muted-2">{index}</span>
      <div>
        <h3 className="font-display text-xl font-semibold tracking-tight text-ink">{title}</h3>
        <p className="mt-2 max-w-md editorial-p">{body}</p>
        {detail && (
          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
            {detail.map((d) => (
              <li key={d} className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-2">
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hidden md:block" />
      {href && cta && <InlineArrowLink href={href} className="self-start md:self-center">{cta}</InlineArrowLink>}
    </div>
  );
}

/** Mono label + large number (confidence, coverage, score). */
export function TechnicalMetric({ label, value, unit, className }: { label: string; value: string; unit?: string; className?: string }) {
  return (
    <div className={className}>
      <p className="mono-label">{label}</p>
      <p className="mt-1 technical-value">
        {value}
        {unit && <span className="ml-0.5 text-base font-normal text-muted-2">{unit}</span>}
      </p>
    </div>
  );
}

/** Code-like typography block — reads real routes only. */
export function CodePreview({ children, className }: { children: string; className?: string }) {
  return (
    <pre className={cn("overflow-x-auto rounded-md border border-ink/10 bg-ink/[0.05] p-4 font-mono text-[13px] leading-relaxed text-ink/90", className)}>
      <code>{children}</code>
    </pre>
  );
}

/** Minimal editorial pipeline diagram (CSS). */
export function PipelineDiagram({ steps, className }: { steps: string[]; className?: string }) {
  return (
    <ol className={cn("space-y-0", className)}>
      {steps.map((step, i) => (
        <li key={step} className="flex items-center gap-4">
          <span className="section-label width-0 flex-none tabular-nums text-muted-2">{String(i + 1).padStart(2, "0")}</span>
          <span className="border-t border-ink/10 py-3 font-mono text-sm uppercase tracking-[0.14em] text-ink/80">{step}</span>
          {i < steps.length - 1 && <span className="text-accent-ink">↓</span>}
        </li>
      ))}
    </ol>
  );
}

/** Product status groups. The caller derives them from `products` (lib/site). */
export function ProductStatus({ groups }: { groups: Array<{ label: string; items: string[] }> }) {
  if (groups.length === 0) return null;
  return (
    <div className={cn("grid gap-8", groups.length > 1 && "md:grid-cols-2")}>
      {groups.map((group) => {
        const live = group.label === "LIVE";
        return (
          <div key={group.label}>
            <StatusBadge label={group.label} className="mb-3" />
            <ul className="space-y-2">
              {group.items.map((item) => (
                <li key={item} className={cn("flex items-center gap-2 text-sm", live ? "text-ink/90" : "text-muted-foreground")}>
                  <span className={cn("h-1 w-1 rounded-full", live ? "bg-accent" : "bg-muted-2")} aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Editorial empty state. */
export function EmptyState({ title, body, action }: { title: string; body: string; action?: { label: string; href: string } }) {
  return (
    <div className="rounded-md border border-dashed border-ink/15 p-8 text-center">
      <p className="mono-label">{title}</p>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">{body}</p>
      {action && (
        <Link href={action.href} className="btn-secondary mt-5">
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** Editorial error state. */
export function ErrorState({ title, message, retry }: { title: string; message: string; retry?: () => void }) {
  return (
    <div className="rounded-md border border-red-600/20 p-8 text-center">
      <p className="mono-label text-red-700">{title}</p>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">{message}</p>
      {retry && (
        <button type="button" onClick={retry} className="btn-secondary mt-5">
          Retry
        </button>
      )}
    </div>
  );
}

/** Thin hairline divider. */
export function Divider({ className }: { className?: string }) {
  return <hr className={cn("hairline", className)} />;
}
