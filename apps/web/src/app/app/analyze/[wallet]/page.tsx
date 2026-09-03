import WalletXRayPage from "@/components/wallet-x-ray";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet X-Ray",
  description: "Evidence-based privacy intelligence for a Solana wallet."
};

export default async function WalletAnalysisPage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return <WalletXRayPage wallet={wallet} />;
}
