import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { SITE_URL } from "@/lib/site";

// Plex for interface and data, Newsreader for editorial statements. Newsreader
// is the cut without its optical-size axis: with it the file is 128 KB, without it 56.
// The files are in the repository (src/fonts, see its README): fetched from
// Google at build time, a bad answer failed the build.
const sans = localFont({ src: "../fonts/ibm-plex-sans-latin.woff2", weight: "400 700", style: "normal", variable: "--font-sans", display: "swap" });
const mono = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-mono-500-latin.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-mono-600-latin.woff2", weight: "600", style: "normal" }
  ],
  variable: "--font-mono",
  display: "swap"
});
const serif = localFont({ src: "../fonts/newsreader-latin.woff2", weight: "200 800", style: "normal", variable: "--font-serif", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "AEGIX — Financial & On-Chain Intelligence",
    template: "%s · AEGIX"
  },
  description:
    "AEGIX turns public on-chain and financial data into relationships, patterns, signals and intelligence. Starting with privacy intelligence on Solana — Wallet X-Ray, cross-wallet correlation, attack-path analysis, and privacy monitoring.",
  keywords: [
    "on-chain intelligence",
    "financial intelligence",
    "Solana privacy",
    "wallet x-ray",
    "blockchain analytics",
    "privacy exposure",
    "observable linkability"
  ],
  alternates: {
    canonical: "/"
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: "AEGIX",
    title: "AEGIX — See What Others Don't.",
    description:
      "Financial & on-chain intelligence on Solana. Wallet X-Ray, correlation, attack-path analysis, and privacy monitoring. See what others don't.",
    images: [
      {
        url: "/assets/aegix-financial-onchain-intelligence.jpg",
        width: 1280,
        height: 720,
        alt: "AEGIX — Financial & On-Chain Intelligence: a marble head among market, commodity, macro and on-chain plates"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "AEGIX — See What Others Don't.",
    description:
      "Financial & on-chain intelligence on Solana. Wallet X-Ray, correlation, attack-path analysis, and privacy monitoring.",
    images: ["/assets/aegix-financial-onchain-intelligence.jpg"]
  },
  robots: {
    index: true,
    follow: true
  }
};

export const viewport: Viewport = {
  themeColor: "#efe6d3",
  colorScheme: "light"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body className="min-h-screen bg-paper text-ink antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
