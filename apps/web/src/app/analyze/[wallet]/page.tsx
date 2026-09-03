import { redirect } from "next/navigation";

export default async function LegacyWalletAnalysisPage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  redirect(`/app/analyze/${wallet}`);
}
