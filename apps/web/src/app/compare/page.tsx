import ComparePage from "@/components/compare-page";

export default async function CompareRoute({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  return <ComparePage initialA={a ?? ""} initialB={b ?? ""} />;
}
