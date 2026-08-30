import AnalysisTracker from "@/components/analysis-tracker";

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold">Wallet Analysis</h1>
        <p className="mt-2 text-sm text-slate-500">Analysis ID: {id}</p>
      </div>
      <AnalysisTracker analysisId={id} />
      <a href="/" className="mt-8 text-sm text-accent underline">
        Analyze another wallet
      </a>
    </main>
  );
}
