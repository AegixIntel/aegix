import AnalyzeForm from "@/components/analyze-form";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Wallet X-Ray",
  description: "Analyze a Solana wallet's public on-chain privacy exposure."
};

export default function AnalyzePage({ searchParams }: { searchParams: Promise<{ address?: string }> }) {
  return (
    <div className="container-page py-10">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-marble md:text-4xl">
          Wallet X-Ray
        </h1>
        <p className="mt-3 text-muted-foreground">
          Analyze a Solana wallet&apos;s public on-chain activity. See exposure, evidence, and limitations —
          all backed by real analysis.
        </p>
      </div>
      <AnalyzeForm />
    </div>
  );
}
