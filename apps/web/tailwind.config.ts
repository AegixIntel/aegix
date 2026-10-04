import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Paper: the cream of the brand plates, sampled from them.
        paper: "#efe6d3",
        "paper-raised": "#f6efe0",
        "paper-deep": "#e5dbc5",
        // Ink: text, rules and solid controls.
        ink: "#14120f",
        "muted-foreground": "#544e45",
        "muted-2": "#6d665a",
        // Signal orange. `accent` fills and marks; `accent-ink` is the
        // darker cut that stays legible as text on paper.
        accent: "#f24011",
        "accent-ink": "#c2320a",
        "accent-dim": "rgba(242, 64, 17, 0.12)"
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
