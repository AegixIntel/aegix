import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="mt-4 text-lg text-muted-foreground">This page does not exist.</p>
      <Link href="/" className="mt-6 rounded-lg border border-ink/15 px-4 py-2 text-sm text-ink/80 hover:border-accent">
        Back to AEGIX
      </Link>
    </main>
  );
}
