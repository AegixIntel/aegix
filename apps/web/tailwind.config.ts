import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b1020",
        "ink-deep": "#05070d",
        "ink-raised": "#111832",
        accent: "#6c5ce7",
        "accent-bright": "#8b7cff",
        marble: "#f5f6f7",
        "muted-foreground": "#9aa3b5"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"]
      },
      letterSpacing: {
        tightest: "-0.04em"
      },
      backgroundImage: {
        "accent-gradient": "linear-gradient(135deg, #6c5ce7 0%, #8b7cff 100%)",
        "hero-glow":
          "radial-gradient(ellipse 80% 50% at 20% 10%, rgba(108,92,231,0.18), transparent 60%)"
      }
    }
  },
  plugins: []
};

export default config;
