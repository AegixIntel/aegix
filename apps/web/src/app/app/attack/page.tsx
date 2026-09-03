import AttackWalletPage from "@/components/attack-wallet";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Attack My Wallet",
  description: "Follow observable paths through a Solana wallet's public on-chain activity."
};

export default async function AttackPage({ searchParams }: { searchParams: Promise<{ address?: string }> }) {
  const { address } = await searchParams;
  return (
    <div>
      <AttackWalletPage initialAddress={address ?? ""} />
    </div>
  );
}
