import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Near-black neutral institutional base.
        ink: "#0a0a0a",
        "ink-deep": "#050505",
        "ink-raised": "#111111",
        // Foreground.
        marble: "#f2f2f2",
        "muted-foreground": "#9ca3af",
        "muted-2": "#6b7280",
        // AEGIX violet accent — used sparingly.
        accent: "#6c5ce7",
        "accent-bright": "#8b7cff",
        "accent-dim": "rgba(108, 92, 231, 0.14)"
      },
      // Font variables are provided by next/font in app/layout.tsx.
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "Times New Roman", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"]
      },
      letterSpacing: {
        tightest: "-0.04em"
      },
      maxWidth: {
        content: "72rem",
        narrow: "44rem",
        wide: "86rem"
      },
      spacing: {
        section: "7rem",
        "section-sm": "5rem"
      }
    }
  },
  plugins: []
};

export default config;
