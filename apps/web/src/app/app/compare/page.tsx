import ComparePage from "@/components/compare-page";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Compare Wallets",
  description: "Compare two Solana wallets' observable on-chain behavior and correlation."
};

export default async function CompareRoute({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  return (
    <div className="container-page py-10">
      <ComparePage initialA={a ?? ""} initialB={b ?? ""} />
    </div>
  );
}
