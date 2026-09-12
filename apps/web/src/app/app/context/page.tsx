import WalletContextPage from "@/components/wallet-context";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet Context",
  description:
    "Contextual indicators assembled from deterministic AEGIX intelligence, each traceable to the engine that produced it."
};

export default async function ContextPage({ searchParams }: { searchParams: Promise<{ address?: string }> }) {
  const { address } = await searchParams;
  return (
    <div>
      <WalletContextPage initialAddress={address ?? ""} />
    </div>
  );
}
