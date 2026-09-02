/**
 * D6-I1 unit tests: correlation-email content (epistemic-safe language) and
 * eligibility gates. Pure functions only — no DB/queue needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "@aegix/config";
import {
  buildCorrelationEmail,
  correlationEmailEligibility,
  correlationEventLabel,
  shortWallet
} from "./notification-email.js";
import type { CorrelationChangeCandidate } from "./correlation.js";

const WALLET_MON = "EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj";
const WALLET_REL = "DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    EMAIL_ENABLED: true,
    ENABLE_EMAIL_NOTIFICATIONS: true,
    EMAIL_PROVIDER: "console",
    AUTH_APP_URI: "https://aegix.app",
    ...overrides
  } as AppConfig;
}

function candidate(overrides: Partial<CorrelationChangeCandidate> = {}): CorrelationChangeCandidate {
  return {
    eventType: "CORRELATION_INCREASED",
    severity: "HIGH",
    confidence: 0.76,
    relatedWallet: WALLET_REL,
    previousScore: 34,
    newScore: 71,
    previousConfidence: 0.5,
    newConfidence: 0.76,
    title: "Correlation increased",
    summary: "Correlation with DpFKMQ… increased from 34 to 71 (+37).",
    explanation: "explanation",
    fingerprint: "fp",
    evidence: { addedFamilies: ["FUNDING"], removedFamilies: [] },
    limitations: [],
    ...overrides
  };
}

test("shortWallet: short display form", () => {
  assert.equal(shortWallet(WALLET_MON), "EH2qq6…YMmj");
  assert.equal(shortWallet("abcdefgh"), "abcdefgh");
});

test("correlationEventLabel: known + fallback labels", () => {
  assert.equal(correlationEventLabel("CORRELATION_APPEARED"), "New correlation observed");
  assert.equal(correlationEventLabel("CORRELATION_INCREASED"), "Correlation increased");
  assert.equal(correlationEventLabel("UNKNOWN_THING"), "UNKNOWN THING");
});

test("eligibility: email disabled → ineligible with reason", () => {
  const r = correlationEmailEligibility({
    config: config({ EMAIL_ENABLED: false }),
    providerConfigured: true,
    recipient: { email: "a@example.com", verifiedAt: new Date().toISOString() }
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "email disabled");
});

test("eligibility: provider missing → ineligible", () => {
  const r = correlationEmailEligibility({
    config: config(),
    providerConfigured: false,
    recipient: { email: "a@example.com", verifiedAt: new Date().toISOString() }
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "email provider not configured");
});

test("eligibility: no verified recipient → ineligible (§8: never email unverified)", () => {
  const none = correlationEmailEligibility({ config: config(), providerConfigured: true, recipient: null });
  assert.equal(none.eligible, false);
  const unverified = correlationEmailEligibility({
    config: config(),
    providerConfigured: true,
    recipient: { email: "a@example.com", verifiedAt: null }
  });
  assert.equal(unverified.eligible, false);
  assert.match(unverified.reason ?? "", /no verified notification email/);
});

test("eligibility: verified recipient + email on → eligible", () => {
  const r = correlationEmailEligibility({
    config: config(),
    providerConfigured: true,
    recipient: { email: "a@example.com", verifiedAt: new Date().toISOString() }
  });
  assert.equal(r.eligible, true);
  assert.equal(r.hasVerifiedRecipient, true);
});

test("email content: safe language, never ownership/identity", () => {
  const { subject, body } = buildCorrelationEmail({
    candidate: candidate(),
    monitoredWallet: WALLET_MON,
    timestamp: "2026-09-02T12:00:00.000Z",
    appUri: "https://aegix.app"
  });
  assert.match(subject, /correlation increased/);
  assert.match(body, /Monitored wallet: EH2qq6…YMmj/);
  assert.match(body, /Related wallet: DpFKMQ…m8Eb/);
  assert.match(body, /Correlation strength: 34 → 71/);
  assert.match(body, /Confidence: 76%/);
  assert.match(body, /repeated funding relationship/);
  assert.match(body, /View comparison: https:\/\/aegix.app\/compare\?walletA=EH2qq6FqPHk1vbfLjaNceGADeKTTPEVuQmQyC9YtYMmj&walletB=DpFKMQXG21YQTUsCKGusU6SuQpAnR87dqu5DJL8Hm8Eb/);
  // Epistemic safety: never claims ownership/identity as a conclusion.
  assert.ok(!body.toLowerCase().includes("owned by"));
  assert.ok(!body.toLowerCase().includes("same owner"));
  assert.ok(!body.toLowerCase().includes("you own"));
  assert.match(body, /does not prove common ownership or real-world identity/);
});

test("email content: APPEARED without previous score renders new score only", () => {
  const { body } = buildCorrelationEmail({
    candidate: candidate({ eventType: "CORRELATION_APPEARED", previousScore: null, newScore: 65, severity: "MEDIUM" }),
    monitoredWallet: WALLET_MON
  });
  assert.match(body, /Correlation strength: 65/);
  assert.doesNotMatch(body, /→/);
  assert.match(body, /New correlation observed/);
});

test("email content: removed families are listed as counter-evidence", () => {
  const { body } = buildCorrelationEmail({
    candidate: candidate({ evidence: { addedFamilies: [], removedFamilies: ["TEMPORAL_CORRELATION"] } }),
    monitoredWallet: WALLET_MON
  });
  assert.match(body, /evidence no longer observed: timing correlation/);
});
