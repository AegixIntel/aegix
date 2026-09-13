"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCheckoutClient } from "@/lib/api";

/**
 * The hosted-checkout landing page (the processor's "default payment link").
 *
 * The API created the checkout server-side and sent the customer here with
 * its id in `_ptxn`. This page only loads Paddle.js with the public client
 * token; Paddle opens its own payment form for that checkout. Card details go
 * to Paddle and never touch AEGIX. Completing payment returns to Plan & usage,
 * which waits for the API to hear from Paddle before showing the new plan.
 */

const PADDLE_JS = "https://cdn.paddle.com/paddle/v2/paddle.js";

interface PaddleJs {
  Environment: { set(environment: string): void };
  Initialize(options: {
    token: string;
    checkout?: { settings?: Record<string, unknown> };
    eventCallback?: (event: { name?: string }) => void;
  }): void;
}

let initialized = false;

function loadPaddle(): Promise<PaddleJs> {
  const existing = (window as unknown as { Paddle?: PaddleJs }).Paddle;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PADDLE_JS;
    script.async = true;
    script.onload = () => {
      const paddle = (window as unknown as { Paddle?: PaddleJs }).Paddle;
      if (paddle) resolve(paddle);
      else reject(new Error("The payment form did not load"));
    };
    script.onerror = () => reject(new Error("The payment form could not be loaded"));
    document.head.appendChild(script);
  });
}

export default function BillingCheckout() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const transaction = new URLSearchParams(window.location.search).get("_ptxn");
    if (!transaction || !/^txn_[a-z0-9]+$/.test(transaction)) {
      setError("This checkout link is incomplete. Start again from Plan & usage.");
      return;
    }
    if (initialized) return;
    let active = true;
    void (async () => {
      try {
        const client = await getCheckoutClient();
        const paddle = await loadPaddle();
        if (!active || initialized) return;
        initialized = true;
        if (client.environment === "sandbox") paddle.Environment.set("sandbox");
        let completed = false;
        paddle.Initialize({
          token: client.token,
          checkout: {
            settings: {
              displayMode: "overlay",
              successUrl: `${window.location.origin}/app/billing?checkout=complete`
            }
          },
          eventCallback: (event) => {
            if (event.name === "checkout.completed") completed = true;
            if (event.name === "checkout.closed" && !completed) window.location.assign("/app/billing");
          }
        });
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Checkout is unavailable");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="font-display text-2xl font-semibold text-marble">Secure checkout</h1>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-amber-300">
          {error}
        </p>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          Opening the payment form. Payment details go straight to our payment processor; AEGIX never sees them.
        </p>
      )}
      <p className="mt-6 text-sm">
        <Link href="/app/billing" className="text-accent underline">
          Back to Plan &amp; usage
        </Link>
      </p>
    </main>
  );
}
