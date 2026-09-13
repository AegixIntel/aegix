"use client";

import { useCallback, useEffect, useState } from "react";
import {
  cancelSubscription,
  getBillingInvoices,
  getBillingPlans,
  getBillingSubscription,
  getBillingUsage,
  requestUpgrade,
  resumeSubscription,
  type BillingInvoice,
  type BillingPlansResponse,
  type BillingSubscription,
  type BillingUsage,
  type PlanCode
} from "@/lib/api";
import { useRequireAuth } from "@/lib/auth-guard";

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);

const ENTITLEMENT_LABEL: Record<string, string> = {
  "analysis.daily": "Wallet analyses per day",
  "compare.daily": "Comparisons per day",
  "ask.daily": "Ask AEGIX questions per day",
  "markets.daily": "Market reads per day",
  "monitors.active": "Active privacy monitors",
  "apiKeys.active": "Active API keys",
  "webhooks.active": "Active webhook endpoints",
  "api.daily": "Developer API units per day"
};

const DIMENSION_LABEL: Record<string, string> = {
  WALLET_ANALYSIS: "Wallet analyses",
  COMPARISON: "Comparisons",
  WALLET_CONTEXT: "Wallet context reads",
  ASK_AEGIX: "Ask AEGIX questions",
  MARKETS: "Market reads",
  API_CALLS: "Developer API units",
  MONITORED_WALLETS: "Monitored wallets"
};

const STATUS_NOTE: Record<string, string> = {
  NONE: "No subscription. You are on the free plan.",
  TRIALING: "Trial in progress.",
  ACTIVE: "Active.",
  PAST_DUE: "Payment failed. Paid limits continue until the grace period ends, then drop to free.",
  CANCELED: "Cancellation scheduled. Paid limits continue until the end of the current period.",
  EXPIRED: "Ended. You are on the free plan."
};

export default function Billing() {
  const [plans, setPlans] = useState<BillingPlansResponse | null>(null);
  const [subscription, setSubscription] = useState<BillingSubscription | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requesting, setRequesting] = useState<PlanCode | null>(null);
  const [contact, setContact] = useState("");
  const { requireAuth } = useRequireAuth();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [planData, sub, use, inv] = await Promise.all([
        getBillingPlans(),
        getBillingSubscription(),
        getBillingUsage(),
        getBillingInvoices()
      ]);
      setPlans(planData);
      setSubscription(sub);
      setUsage(use);
      setInvoices(inv.invoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing is unavailable");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That change could not be applied");
    } finally {
      setBusy(false);
    }
  }

  const currency = plans?.currency ?? "USD";
  const enforced = subscription?.plan;
  const liveTier =
    subscription && subscription.status !== "NONE" && subscription.status !== "EXPIRED"
      ? subscription.subscribedPlan?.tier ?? 0
      : 0;
  const requestedPlan = subscription?.upgradeRequest
    ? plans?.plans.find((p) => p.code === subscription.upgradeRequest?.plan)
    : undefined;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-marble">Plan &amp; usage</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your plan sets the limits AEGIX enforces. Usage is metered from the same records the product
        counts against your quotas — nothing here is estimated.
      </p>

      {error ? (
        <p role="alert" className="mt-6 text-sm text-amber-300">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mt-6 text-sm text-emerald-300">{notice}</p> : null}

      {subscription ? (
        <section className="card-surface mt-6 p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold text-marble">
              {enforced?.name ?? "Free"}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {enforced && enforced.priceCents > 0
                  ? `${money(enforced.priceCents, enforced.currency)} / ${enforced.interval.toLowerCase()}`
                  : "no charge"}
              </span>
            </h2>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{subscription.status}</span>
          </div>
          <p className="mt-2 text-sm text-slate-300">{STATUS_NOTE[subscription.status]}</p>

          {subscription.degraded ? (
            <p className="mt-2 text-sm text-amber-300">
              You are subscribed to {subscription.subscribedPlan?.name}, but {enforced?.name ?? "free"} limits are
              being enforced right now. Your data and saved work are untouched.
            </p>
          ) : null}

          <p className="mt-3 text-xs text-slate-500">
            Current period {new Date(subscription.period.start).toLocaleDateString()} —{" "}
            {new Date(subscription.period.end).toLocaleDateString()}
            {subscription.cancelAtPeriodEnd ? " · cancels at period end" : ""}
            {subscription.gracePeriodEnd ? ` · grace ends ${new Date(subscription.gracePeriodEnd).toLocaleDateString()}` : ""}
          </p>

          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {Object.entries(subscription.entitlements).map(([key, value]) => (
              <div key={key} className="flex justify-between border-b border-white/5 py-1 text-sm">
                <dt className="text-muted-foreground">{ENTITLEMENT_LABEL[key] ?? key}</dt>
                <dd className="font-semibold text-marble">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 flex flex-wrap gap-3">
            {subscription.status === "CANCELED" ? (
              <button
                className="btn-primary px-4 py-2 text-sm"
                disabled={busy}
                onClick={() => void requireAuth(() => act(() => resumeSubscription(), "Cancellation revoked."))}
              >
                Keep my plan
              </button>
            ) : null}
            {["TRIALING", "ACTIVE", "PAST_DUE"].includes(subscription.status) ? (
              <button
                className="rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-200"
                disabled={busy}
                onClick={() =>
                  void requireAuth(() =>
                    act(() => cancelSubscription(false), "Cancellation scheduled for the end of the current period.")
                  )
                }
              >
                Cancel at period end
              </button>
            ) : null}
          </div>

          {subscription.upgradeRequest ? (
            <p className="mt-4 text-sm text-slate-300">
              Upgrade to {requestedPlan?.name ?? subscription.upgradeRequest.plan} requested on{" "}
              {new Date(subscription.upgradeRequest.requestedAt).toLocaleDateString()}. It is pending manual activation by
              the AEGIX team; your current limits apply until then.
            </p>
          ) : null}

          {plans && !plans.selfServe ? (
            <p className="mt-4 text-xs text-slate-500">
              Paid plans are provisioned manually for now. Request an upgrade on the plan you want and the AEGIX team
              will get in touch to arrange payment; the plan is activated once payment is confirmed. Cancelling never
              needs a request.
            </p>
          ) : null}
        </section>
      ) : null}

      {plans ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-marble">Plans</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {plans.plans.map((plan) => (
              <div
                key={plan.code}
                className={`card-surface p-5 ${plan.code === enforced?.code ? "border border-accent/40" : ""}`}
              >
                <h3 className="text-base font-semibold text-marble">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {plan.priceCents > 0 ? `${money(plan.priceCents, plan.currency)} / ${plan.interval.toLowerCase()}` : "Free"}
                </p>
                <ul className="mt-3 space-y-1 text-xs text-slate-400">
                  {Object.entries(plan.entitlements).map(([key, value]) => (
                    <li key={key} className="flex justify-between gap-3">
                      <span>{ENTITLEMENT_LABEL[key] ?? key}</span>
                      <span className="font-semibold text-slate-200">{value}</span>
                    </li>
                  ))}
                </ul>
                {plan.code === enforced?.code ? (
                  <p className="mt-3 text-xs uppercase tracking-wide text-accent">Current</p>
                ) : null}
                {!plans.selfServe && plan.priceCents > 0 && plan.tier > liveTier ? (
                  subscription?.upgradeRequest?.plan === plan.code ? (
                    <p className="mt-4 text-xs uppercase tracking-wide text-slate-400">Upgrade requested</p>
                  ) : requesting === plan.code ? (
                    <form
                      className="mt-4 space-y-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void requireAuth(async () => {
                          await act(
                            () => requestUpgrade(plan.code, contact),
                            `Upgrade request sent for ${plan.name}. Your plan stays as it is until the AEGIX team confirms payment and activates it.`
                          );
                          setRequesting(null);
                        });
                      }}
                    >
                      <label htmlFor={`contact-${plan.code}`} className="block text-xs text-muted-foreground">
                        How should we reach you? Email or Telegram (optional)
                      </label>
                      <input
                        id={`contact-${plan.code}`}
                        className="w-full rounded-lg border border-white/10 bg-transparent px-3 py-2 text-sm text-marble"
                        maxLength={200}
                        value={contact}
                        onChange={(event) => setContact(event.target.value)}
                      />
                      <div className="flex gap-2">
                        <button type="submit" className="btn-primary flex-1 px-3 py-2 text-sm" disabled={busy}>
                          Send request
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300"
                          onClick={() => setRequesting(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      className="btn-primary mt-4 w-full px-4 py-2 text-sm"
                      disabled={busy}
                      onClick={() =>
                        void requireAuth(async () => {
                          setRequesting(plan.code as PlanCode);
                        })
                      }
                    >
                      Request upgrade
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {usage ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-marble">Usage this period</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {usage.days} days · {new Date(usage.period.start).toLocaleDateString()} —{" "}
            {new Date(usage.period.end).toLocaleDateString()}
          </p>
          <div className="card-surface mt-4 divide-y divide-white/5">
            {usage.dimensions.map((dimension) => (
              <div key={dimension.dimension} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <span className="text-muted-foreground">{DIMENSION_LABEL[dimension.dimension] ?? dimension.dimension}</span>
                <span className="text-marble">
                  {dimension.units}
                  {dimension.includedUnits !== null ? (
                    <span className="text-muted-foreground"> / {dimension.includedUnits} included</span>
                  ) : (
                    <span className="text-muted-foreground"> · no plan limit</span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Cached results are not counted: a report served from cache does no new work, so it consumes no quota.
          </p>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-marble">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No invoices yet. One is raised for each billing period that closes on a paid plan.
          </p>
        ) : (
          <div className="card-surface mt-4 divide-y divide-white/5">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                <span className="text-muted-foreground">
                  {new Date(invoice.period_start).toLocaleDateString()} — {new Date(invoice.period_end).toLocaleDateString()}
                  <span className="ml-2 text-xs uppercase tracking-wide">{invoice.status}</span>
                </span>
                <span className="font-semibold text-marble">{money(invoice.total_cents, invoice.currency || currency)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
