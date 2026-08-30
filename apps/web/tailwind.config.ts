import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b1020",
        accent: "#6c5ce7"
      }
    }
  },
  plugins: []
};

export default config;
