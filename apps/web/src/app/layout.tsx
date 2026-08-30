import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AEGIX — On-Chain Privacy Intelligence",
  description: "Know what the blockchain knows about your wallet."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink text-slate-100 antialiased">{children}</body>
    </html>
  );
}
