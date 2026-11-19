"use client";

import { useState } from "react";
import { TOKEN_CA } from "@/lib/site";

/** The token's contract address with a copy button. Wraps on narrow screens rather than overflowing. */
export function ContractAddress({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(TOKEN_CA);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard unavailable (insecure context or denied); the address stays selectable. */
    }
  }

  return (
    <div
      className={`inline-flex max-w-full items-center gap-3 border border-ink/15 bg-paper px-3 py-2 ${className}`}
      style={style}
    >
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-2">CA</span>
      <code className="mono-address min-w-0 select-all break-all text-ink">{TOKEN_CA}</code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy contract address"
        className="shrink-0 font-mono text-[11px] uppercase tracking-[0.16em] text-accent transition hover:text-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
