import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { SITE_URL } from "@/lib/site";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap"
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap"
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "AEGIX — On-Chain Privacy Intelligence for Solana",
    template: "%s · AEGIX"
  },
  description:
    "AEGIX turns public Solana blockchain activity into evidence-based privacy intelligence. Wallet X-Ray, cross-wallet correlation, attack path analysis, and privacy monitoring. Know what the blockchain knows.",
  keywords: [
    "on-chain intelligence",
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
    title: "AEGIX — Know What the Blockchain Knows.",
    description:
      "Evidence-based on-chain privacy intelligence for Solana. Wallet X-Ray, correlation, attack-path analysis, and privacy monitoring.",
    images: [
      {
        url: "/assets/aegix-wallet-intelligence.jpg",
        width: 1280,
        height: 720,
        alt: "AEGIX Wallet Intelligence dashboard showing privacy exposure"
      }
    ]
  },
  twitter: {
    card: "summary_large_image",
    title: "AEGIX — Know What the Blockchain Knows.",
    description:
      "Evidence-based on-chain privacy intelligence for Solana. Wallet X-Ray, correlation, attack-path analysis, and privacy monitoring.",
    images: ["/assets/aegix-wallet-intelligence.jpg"]
  },
  robots: {
    index: true,
    follow: true
  }
};

export const viewport: Viewport = {
  themeColor: "#05070d",
  colorScheme: "dark"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} ${jetBrainsMono.variable}`}>
      <body className="min-h-screen bg-ink-deep text-marble antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
