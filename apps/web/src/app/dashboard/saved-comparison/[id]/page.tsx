import { redirect } from "next/navigation";

export default async function LegacySavedComparisonRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/app/saved/${id}`);
}
