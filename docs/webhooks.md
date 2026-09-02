# AEGIX Webhooks — Consumer Verification Guide

AEGIX delivers monitor and correlation events to your webhook endpoint as
signed HTTP POST requests. This document is the canonical consumer guide:
headers, signature scheme, verification, retry/idempotency semantics, and
security notes. The reference implementation is
`verifyWebhookRequest` from `@aegix/webhook-delivery` (see below).

---

## 1. Event envelope

Every delivery is a JSON object with a stable shape:

```json
{
  "id": "uuid-of-this-delivery",
  "type": "monitor.threat.created",
  "createdAt": "2026-09-02T12:00:00.000Z",
  "data": { }
}
```

Event types:

| Type | Meaning |
|---|---|
| `monitor.threat.created` | A monitored-wallet threat event (privacy exposure, new entity exposure, new attack path, data quality degraded) |
| `correlation.appeared` | A new observable correlation crossed your alert threshold |
| `correlation.increased` | A persisted correlation increased meaningfully |
| `correlation.decreased` | A persisted correlation left the strong band |
| `correlation.disappeared` | A previously persisted correlation is no longer present (low-confidence informational event) |

AEGIX reports **observable relationships and correlation evidence**.
Correlation does not establish common ownership or real-world identity.
Do not build identity/ownership conclusions from these events.

## 2. Delivery headers

| Header | Example | Meaning |
|---|---|---|
| `aegix-webhook-id` | `42` | Your webhook's AEGIX id |
| `aegix-event-id` | `evt_01...` | Unique id of this logical event |
| `aegix-timestamp` | `1720000000` | Unix time (seconds) when the request was signed |
| `aegix-signature` | `hex…` | HMAC-SHA256 of `timestamp + "." + rawBody`, hex-encoded |

## 3. Signature verification (required)

**Always verify signatures, and always use the exact raw request body
bytes.** Never do `JSON.parse(body)` → `JSON.stringify(body)` → verify:
serialization differences (whitespace, number formatting, unicode escapes)
silently invalidate the signature.

Scheme:

```text
signature = hex( HMAC-SHA256( secret, "<aegix-timestamp>.<rawBody>" ) )
```

- Algorithm: HMAC-SHA256.
- Signed bytes: the ASCII timestamp, a literal `.`, then the raw request
  body **exactly as received**.
- Encoding: signature is lowercase hex (64 chars).
- Secret: the `secret` shown exactly once when you create/rotate the webhook
  in the AEGIX dashboard.

### Reference helper (TypeScript/Node)

The canonical consumer implementation ships in `@aegix/webhook-delivery`:

```ts
import { verifyWebhookRequest } from "@aegix/webhook-delivery";

// In your HTTP handler, pass the RAW body string:
const result = verifyWebhookRequest({
  rawBody,                              // exact request body text
  signature: req.headers["aegix-signature"],
  timestamp:  req.headers["aegix-timestamp"],
  secret,                               // from the dashboard (shown once)
  toleranceSeconds: 300                 // 5 minutes clock skew
});

if (!result.valid) {
  // result.reason: MISSING_SIGNATURE | MISSING_TIMESTAMP |
  //   MALFORMED_TIMESTAMP | MALFORMED_SIGNATURE | TOO_OLD |
  //   TOO_FAR_IN_FUTURE | SIGNATURE_MISMATCH
  return res.status(401).end();
}
```

The helper performs constant-time comparison and enforces timestamp
freshness: too old and too-far-in-the-future timestamps are rejected
(replay protection). If you implement verification yourself, use
`crypto.timingSafeEqual` on the decoded digests.

### Hand-rolled example (any language)

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: string, signature: string | undefined,
                timestamp: string | undefined, secret: string): boolean {
  if (!signature || !timestamp) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8").digest();
  const provided = Buffer.from(signature, "hex");
  if (provided.length !== expected.length) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!/^\d{1,10}$/.test(timestamp) || skew > 300) return false;
  return timingSafeEqual(provided, expected);
}
```

## 4. Idempotency & retries

- **Event id**: `data.id` (or the `aegix-event-id` header) identifies one
  logical event. Store processed event ids and ignore duplicates — AEGIX
  retries deliveries, so the same event id may arrive more than once.
- **Retry policy**: transient failures (5xx, 408, 429, network errors,
  timeouts) are retried with exponential backoff up to
  `WEBHOOK_MAX_ATTEMPTS` (8 by default).
- **Permanent failures** (4xx except 408/429) disable the webhook — no more
  retries until you re-enable it.
- **SSRF protection**: destinations are resolved and validated at delivery
  time; private/loopback/link-local/metadata addresses are rejected and the
  webhook is disabled. Redirects are **never followed** — treat a 3xx as a
  permanent failure (the delivery will be marked failed).

## 5. Security notes

- Webhook secrets are encrypted at rest (AES-256-GCM); plaintext is shown
  exactly once at creation and rotation. Rotating a secret invalidates the
  old one immediately — update consumers atomically if you rely on
  dual-secret grace; AEGIX does not keep the previous secret.
- Only `http`/`https` URLs on the allowed port policy are deliverable.
- Never log the full `aegix-signature` or your secret; AEGIX truncates
  delivery logs to host names and bounded error excerpts.
- AEGIX supports exactly one active secret per webhook (rotation replaces
  it), so verification uses the secret returned at creation/rotation time.

## 6. Testing

Use the dashboard's "test delivery" action, or replay recorded delivery
attempts from the webhook detail page. In development you can run a local
receiver on an allowed port with `WEBHOOK_DEV_ALLOW_PRIVATE=true` (never in
production).
