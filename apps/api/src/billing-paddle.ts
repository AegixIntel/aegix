/**
 * Paddle Billing adapter (D11 §6).
 *
 * Paddle is the merchant of record: it runs the hosted checkout, collects
 * payment, handles sales tax and pays out. AEGIX keeps what it always had —
 * the plan catalog, the ledger and entitlement enforcement — and this module
 * is the only place that speaks Paddle's vocabulary. Everything leaving it
 * is a processor-neutral ProviderSubscriptionSnapshot.
 *
 * The API key and webhook secret live in this closure and are sent nowhere
 * but Paddle. Nothing here logs; callers log outcomes, never payloads.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "@aegix/config";
import {
  BillingError,
  createManualProvider,
  type NormalizedSubscriptionStatus,
  type PaymentProvider,
  type PlanCode,
  type ProviderSubscriptionSnapshot,
  type ProviderWebhookEvent
} from "@aegix/billing";

export const PADDLE_PROVIDER = "paddle";

const API_BASE = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com"
} as const;
const PADDLE_API_VERSION = "1";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface PaddleSettings {
  environment: "sandbox" | "production";
  apiKey: string;
  webhookSecret: string;
  /** Client-side token: public by design, used by Paddle.js on the checkout page. */
  clientToken: string;
  /** The server's plan → price map. A browser never names a price. */
  prices: Partial<Record<PlanCode, string>>;
  /** This deployment's checkout page (Paddle's default payment link). */
  checkoutUrl: string;
  webhookToleranceSeconds: number;
  timeoutMs?: number;
}

const ref = (prefix: string) => new RegExp(`^${prefix}_[a-z0-9]{8,64}$`);
const paddleId = (prefix: string) => z.string().regex(ref(prefix));
const instant = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "not a timestamp");

const envelopeSchema = z.object({
  event_id: paddleId("evt"),
  event_type: z.string().regex(/^[a-z_]{1,40}\.[a-z_]{1,40}$/),
  occurred_at: instant,
  data: z.record(z.unknown())
});

export const paddleSubscriptionSchema = z.object({
  id: paddleId("sub"),
  status: z.string().max(32),
  customer_id: paddleId("ctm").nullable().optional(),
  transaction_id: paddleId("txn").nullable().optional(),
  custom_data: z.record(z.unknown()).nullable().optional(),
  items: z.array(z.object({ price: z.object({ id: z.string().max(80) }) })).min(1).max(20),
  current_billing_period: z.object({ starts_at: instant, ends_at: instant }).nullable().optional(),
  scheduled_change: z.object({ action: z.string().max(32), effective_at: instant.nullable().optional() }).nullable().optional(),
  started_at: instant.nullable().optional(),
  canceled_at: instant.nullable().optional(),
  updated_at: instant.nullable().optional()
});

export type PaddleSubscription = z.infer<typeof paddleSubscriptionSchema>;

const transactionSchema = z.object({
  id: paddleId("txn"),
  checkout: z.object({ url: z.string().url().nullable().optional() }).nullable().optional()
});

const portalSchema = z.object({
  urls: z.object({ general: z.object({ overview: z.string().url() }) })
});

// ---- Webhook signatures ----

/** HMAC-SHA256 over `${ts}:${rawBody}`, hex — Paddle's `h1` scheme. */
export function signPaddleWebhook(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest("hex");
}

export type PaddleSignatureResult =
  | { valid: true }
  | { valid: false; reason: "MISSING_SIGNATURE" | "MALFORMED_SIGNATURE" | "SIGNATURE_MISMATCH" | "TIMESTAMP_OUT_OF_TOLERANCE" };

/**
 * Verifies a `Paddle-Signature: ts=…;h1=…` header against the exact raw body.
 * Several `h1` values are accepted so a secret can be rotated without a gap.
 * The timestamp must be within tolerance of now in either direction, which
 * bounds how long a captured request could be replayed; event ids bound the
 * rest.
 */
export function verifyPaddleSignature(input: {
  rawBody: string;
  header: string | string[] | undefined;
  secret: string;
  nowSeconds: number;
  toleranceSeconds: number;
}): PaddleSignatureResult {
  if (input.header === undefined || input.header === "") return { valid: false, reason: "MISSING_SIGNATURE" };
  if (typeof input.header !== "string" || input.header.length > 512) return { valid: false, reason: "MALFORMED_SIGNATURE" };

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(";")) {
    const pieces = part.trim().split("=");
    if (pieces.length !== 2) return { valid: false, reason: "MALFORMED_SIGNATURE" };
    const [key, value] = pieces as [string, string];
    if (key === "ts") {
      if (timestamp !== null) return { valid: false, reason: "MALFORMED_SIGNATURE" };
      timestamp = value;
    } else if (key === "h1") {
      signatures.push(value);
    }
  }
  if (
    timestamp === null ||
    !/^\d{1,12}$/.test(timestamp) ||
    signatures.length === 0 ||
    signatures.length > 4 ||
    signatures.some((signature) => !/^[0-9a-f]{64}$/.test(signature))
  ) {
    return { valid: false, reason: "MALFORMED_SIGNATURE" };
  }

  const expected = Buffer.from(signPaddleWebhook(input.secret, timestamp, input.rawBody), "hex");
  if (!signatures.some((signature) => timingSafeEqual(Buffer.from(signature, "hex"), expected))) {
    return { valid: false, reason: "SIGNATURE_MISMATCH" };
  }
  if (Math.abs(input.nowSeconds - Number(timestamp)) > input.toleranceSeconds) {
    return { valid: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" };
  }
  return { valid: true };
}

// ---- Normalization: the only place Paddle statuses are interpreted ----

function iso(value: string): string {
  return new Date(value).toISOString();
}

function normalizedStatus(subscription: PaddleSubscription): NormalizedSubscriptionStatus {
  const cancelScheduled = subscription.scheduled_change?.action === "cancel";
  switch (subscription.status) {
    case "active":
      return cancelScheduled ? "CANCELED" : "ACTIVE";
    case "trialing":
      return cancelScheduled ? "CANCELED" : "TRIALING";
    case "past_due":
      // A failed payment matters more than a scheduled cancellation.
      return "PAST_DUE";
    case "canceled":
    case "paused":
      // Neither bills nor entitles; both have ended paid access.
      return "EXPIRED";
    default:
      return "INCOMPLETE";
  }
}

export function normalizePaddleSubscription(
  subscription: PaddleSubscription,
  prices: Partial<Record<PlanCode, string>>,
  observedAt: string
): { snapshot: ProviderSubscriptionSnapshot } | { unmapped: "UNKNOWN_PRICE" } {
  const planByPrice = new Map<string, PlanCode>();
  for (const [code, priceId] of Object.entries(prices) as Array<[PlanCode, string | undefined]>) {
    if (priceId) planByPrice.set(priceId, code);
  }
  const plans = subscription.items.map((item) => planByPrice.get(item.price.id));
  const planCode = plans[0];
  if (!planCode || plans.some((code) => code !== planCode)) return { unmapped: "UNKNOWN_PRICE" };

  const status = normalizedStatus(subscription);
  const period = subscription.current_billing_period ?? null;
  const observed = iso(observedAt);
  const periodStart = period?.starts_at ?? subscription.started_at ?? observed;
  const periodEnd =
    status === "EXPIRED"
      ? subscription.canceled_at ?? period?.ends_at ?? observed
      : period?.ends_at ?? subscription.scheduled_change?.effective_at ?? observed;

  return {
    snapshot: {
      provider: PADDLE_PROVIDER,
      subscriptionRef: subscription.id,
      customerRef: subscription.customer_id ?? null,
      planCode,
      status,
      periodStart: iso(periodStart),
      periodEnd: iso(periodEnd),
      trialEnd: status === "TRIALING" && period ? iso(period.ends_at) : null,
      observedAt: observed
    }
  };
}

export function parsePaddleEvent(
  rawBody: string,
  prices: Partial<Record<PlanCode, string>>
): ProviderWebhookEvent | { kind: "invalid"; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid", reason: "MALFORMED_JSON" };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { kind: "invalid", reason: "INVALID_ENVELOPE" };

  const base = {
    eventId: envelope.data.event_id,
    eventType: envelope.data.event_type,
    occurredAt: iso(envelope.data.occurred_at)
  };
  // Every subscription.* event carries the full subscription entity, so the
  // subscription is synced from those alone; transaction events add nothing
  // the subscription does not already say.
  if (!base.eventType.startsWith("subscription.")) return { ...base, kind: "other" };

  const subscription = paddleSubscriptionSchema.safeParse(envelope.data.data);
  if (!subscription.success) return { kind: "invalid", reason: "INVALID_SUBSCRIPTION" };

  const normalized = normalizePaddleSubscription(subscription.data, prices, base.occurredAt);
  if ("unmapped" in normalized) {
    return { ...base, kind: "unmapped", subscriptionRef: subscription.data.id, reason: normalized.unmapped };
  }
  const token = subscription.data.custom_data?.aegix_checkout;
  return {
    ...base,
    kind: "subscription",
    snapshot: normalized.snapshot,
    checkoutRef: subscription.data.transaction_id ?? null,
    checkoutToken: typeof token === "string" && token.length <= 128 ? token : null
  };
}

// ---- API client ----

export function createPaddleProvider(settings: PaddleSettings, fetchImpl: typeof fetch = fetch): PaymentProvider {
  const base = API_BASE[settings.environment];
  const checkoutOrigin = new URL(settings.checkoutUrl).origin;

  async function call(method: "POST" | "PATCH", path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${settings.apiKey}`,
          "content-type": "application/json",
          "paddle-version": PADDLE_API_VERSION
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch {
      throw new BillingError("PROVIDER_UNAVAILABLE", "The payment processor could not be reached");
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // Only the processor's error code is surfaced: its detail can echo request data.
      const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
      const label = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown_error";
      throw new BillingError("PROVIDER_REJECTED", `The payment processor refused the request (${response.status} ${label})`);
    }
    const data = (parsed as { data?: unknown } | null)?.data;
    if (data === undefined || data === null) {
      throw new BillingError("PROVIDER_UNAVAILABLE", "The payment processor returned an unreadable response");
    }
    return data;
  }

  /** Validates a reference before it is interpolated into a processor URL. */
  function checkedRef(value: string, prefix: string): string {
    if (!ref(prefix).test(value)) throw new BillingError("PROVIDER_REJECTED", "Invalid payment processor reference");
    return value;
  }

  function snapshotFrom(data: unknown): ProviderSubscriptionSnapshot {
    const parsed = paddleSubscriptionSchema.safeParse(data);
    if (!parsed.success) throw new BillingError("PROVIDER_UNAVAILABLE", "The payment processor returned an unreadable subscription");
    const normalized = normalizePaddleSubscription(parsed.data, settings.prices, parsed.data.updated_at ?? new Date().toISOString());
    if ("unmapped" in normalized) {
      throw new BillingError("PROVIDER_REJECTED", "The subscription's price is not part of this deployment's plan catalog");
    }
    return normalized.snapshot;
  }

  return {
    name: PADDLE_PROVIDER,
    supportsSelfServe: true,
    checkoutClient: { environment: settings.environment, token: settings.clientToken },
    webhooks: {
      verify({ rawBody, headers, now }) {
        return verifyPaddleSignature({
          rawBody,
          header: headers["paddle-signature"],
          secret: settings.webhookSecret,
          nowSeconds: Math.floor(now.getTime() / 1000),
          toleranceSeconds: settings.webhookToleranceSeconds
        });
      },
      parse(rawBody) {
        return parsePaddleEvent(rawBody, settings.prices);
      }
    },

    async createCheckout({ userId, plan, checkoutToken }) {
      const priceId = settings.prices[plan.code];
      if (!priceId) throw new BillingError("UNKNOWN_PLAN", `Plan ${plan.code} is not sold through the payment processor`);
      const data = await call("POST", "/transactions", {
        items: [{ price_id: priceId, quantity: 1 }],
        collection_mode: "automatic",
        // Carried onto the subscription Paddle creates; the token is what binds it back to this identity.
        custom_data: { aegix_user_id: userId, aegix_checkout: checkoutToken, aegix_plan: plan.code },
        checkout: { url: settings.checkoutUrl }
      });
      const parsed = transactionSchema.safeParse(data);
      const url = parsed.success ? parsed.data.checkout?.url ?? null : null;
      if (!parsed.success || !url) {
        throw new BillingError("PROVIDER_UNAVAILABLE", "The payment processor did not return a checkout link");
      }
      // Customers are only ever sent to this deployment's own checkout page.
      if (new URL(url).origin !== checkoutOrigin) {
        throw new BillingError("PROVIDER_REJECTED", "The payment processor returned a checkout link for another site");
      }
      return { provider: PADDLE_PROVIDER, url, reference: parsed.data.id };
    },

    async createPortalSession({ customerRef, subscriptionRef }) {
      const data = await call("POST", `/customers/${checkedRef(customerRef, "ctm")}/portal-sessions`, {
        subscription_ids: [checkedRef(subscriptionRef, "sub")]
      });
      const parsed = portalSchema.safeParse(data);
      if (!parsed.success || !parsed.data.urls.general.overview.startsWith("https://")) {
        throw new BillingError("PROVIDER_UNAVAILABLE", "The payment processor did not return a portal link");
      }
      return { url: parsed.data.urls.general.overview };
    },

    async cancelSubscription(subscriptionRef, { immediate }) {
      return snapshotFrom(
        await call("POST", `/subscriptions/${checkedRef(subscriptionRef, "sub")}/cancel`, {
          effective_from: immediate ? "immediately" : "next_billing_period"
        })
      );
    },

    async resumeSubscription(subscriptionRef) {
      return snapshotFrom(await call("PATCH", `/subscriptions/${checkedRef(subscriptionRef, "sub")}`, { scheduled_change: null }));
    }
  };
}

/** The deployment's payment provider. `manual` unless a processor is configured. */
export function paymentProviderFromConfig(config: AppConfig, fetchImpl?: typeof fetch): PaymentProvider {
  if (config.BILLING_PROVIDER !== "paddle") return createManualProvider();
  // loadConfig has already refused a paddle deployment missing any of these.
  return createPaddleProvider(
    {
      environment: config.BILLING_ENVIRONMENT,
      apiKey: config.BILLING_SECRET_KEY!,
      webhookSecret: config.BILLING_WEBHOOK_SECRET!,
      clientToken: config.BILLING_CLIENT_TOKEN!,
      prices: { pro: config.BILLING_PRICE_PRO, team: config.BILLING_PRICE_TEAM },
      checkoutUrl: config.BILLING_CHECKOUT_URL!,
      webhookToleranceSeconds: config.BILLING_WEBHOOK_TOLERANCE_SECONDS
    },
    fetchImpl
  );
}
