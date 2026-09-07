"use client";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#05070d] text-white antialiased">
        <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <h1 className="text-4xl font-bold">Something went wrong</h1>
          <p className="mt-4 text-lg text-slate-400">An unexpected error occurred.</p>
          <button
            onClick={() => reset()}
            className="mt-6 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-violet-500"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
