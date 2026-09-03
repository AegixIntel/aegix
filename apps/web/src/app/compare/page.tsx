import { redirect } from "next/navigation";

export default async function LegacyCompareRoute({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  const qs = new URLSearchParams();
  if (a) qs.set("a", a);
  if (b) qs.set("b", b);
  redirect(`/app/compare${qs.size ? `?${qs.toString()}` : ""}`);
}
