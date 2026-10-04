"use client";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-paper text-ink antialiased">
        <main className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <h1 className="text-4xl font-bold">Something went wrong</h1>
          <p className="mt-4 text-lg text-muted-foreground">An unexpected error occurred.</p>
          <button
            onClick={() => reset()}
            className="mt-6 rounded-lg border border-ink/15 px-4 py-2 text-sm text-ink/80 hover:border-accent"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
