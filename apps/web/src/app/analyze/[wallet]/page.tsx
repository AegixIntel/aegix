import WalletXRayPage from "@/components/wallet-x-ray";

export default async function WalletAnalysisPage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return <WalletXRayPage wallet={wallet} />;
}
