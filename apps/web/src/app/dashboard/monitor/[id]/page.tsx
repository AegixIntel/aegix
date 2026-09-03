import { redirect } from "next/navigation";

export default async function LegacyMonitorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/app/monitor/${id}`);
}
