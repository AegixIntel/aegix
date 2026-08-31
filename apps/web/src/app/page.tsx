import AnalyzeForm from "@/components/analyze-form";

export default async function Home({ searchParams }: { searchParams: Promise<{ address?: string }> }) {
  const { address } = await searchParams;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
          AEGIX
        </h1>
        <p className="mt-4 text-lg text-slate-400">
          On-chain privacy intelligence for Solana. Know what the blockchain knows.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Wallet X-Ray · Compare Wallets · Attack My Wallet · Privacy Threat Monitor
        </p>
        <a href="/compare" className="mt-4 inline-block rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-accent">
          Compare two wallets
        </a>
      </div>
      <div className="mt-12 w-full">
        <AnalyzeForm initialAddress={address ?? ""} />
      </div>
      <footer className="mt-16 text-xs text-slate-600">
        AEGIX measures observable linkability — it never claims identity.
      </footer>
    </main>
  );
}
