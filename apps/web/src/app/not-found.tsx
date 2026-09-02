import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="mt-4 text-lg text-slate-400">This page does not exist.</p>
      <Link href="/" className="mt-6 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-accent">
        Back to AEGIX
      </Link>
    </main>
  );
}
