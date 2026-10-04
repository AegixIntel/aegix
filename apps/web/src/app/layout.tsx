import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { SITE_URL } from "@/lib/site";

// Plex for interface and data, Newsreader for editorial statements.
const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });
const serif = Newsreader({ subsets: ["latin"], variable: "--font-serif", display: "swap", axes: ["opsz"] });

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
