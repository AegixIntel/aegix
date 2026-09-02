/**
 * Correlation-alert email content + eligibility (D6-I1), see
 * docs/milestone-d6.md.
 *
 * Email is a notification destination only. Wallet-only authentication is
 * canonical (§7): the recipient comes from a VERIFIED notification email on
 * the profile, never from the login identity, and an unverified destination
 * is never emailed (§8).
 *
 * Language is epistemically safe: the email reports observable correlation
 * changes — it never claims ownership or identity (§9).
 */

import type { AppConfig } from "@aegix/config";
import type { CorrelationChangeCandidate } from "./correlation.js";

/** Short display form of a wallet address. */
export function shortWallet(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface CorrelationEmailEligibility {
  /** Global email kill switch (EMAIL_ENABLED + ENABLE_EMAIL_NOTIFICATIONS). */
  emailEnabled: boolean;
  /** Provider is configured (SMTP or console). */
  providerConfigured: boolean;
  /** The profile has a verified notification email destination. */
  hasVerifiedRecipient: boolean;
  /** True when an EMAIL notification should be created for this event. */
  eligible: boolean;
  reason: string | null;
}

/** Eligibility gate for correlation email fan-out (§6, §13). */
export function correlationEmailEligibility(input: {
  config: AppConfig;
  providerConfigured: boolean;
  recipient: { email: string | null; verifiedAt: string | null } | null;
}): CorrelationEmailEligibility {
  const { config, providerConfigured, recipient } = input;
  const emailEnabled = config.EMAIL_ENABLED && config.ENABLE_EMAIL_NOTIFICATIONS;
  if (!emailEnabled) {
    return { emailEnabled: false, providerConfigured, hasVerifiedRecipient: false, eligible: false, reason: "email disabled" };
  }
  if (!providerConfigured) {
    return { emailEnabled, providerConfigured: false, hasVerifiedRecipient: false, eligible: false, reason: "email provider not configured" };
  }
  const verified = Boolean(recipient?.email && recipient.verifiedAt);
  if (!verified) {
    return { emailEnabled, providerConfigured, hasVerifiedRecipient: false, eligible: false, reason: "no verified notification email" };
  }
  return { emailEnabled, providerConfigured, hasVerifiedRecipient: true, eligible: true, reason: null };
}

/** Human label for a correlation event type. */
export function correlationEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    CORRELATION_APPEARED: "New correlation observed",
    CORRELATION_INCREASED: "Correlation increased",
    CORRELATION_DECREASED: "Correlation decreased",
    CORRELATION_DISAPPEARED: "Correlation no longer persisted",
    NEW_STRONG_FUNDING_RELATIONSHIP: "New strong funding relationship",
    NEW_CLUSTER_MEMBERSHIP: "New cluster membership"
  };
  return labels[eventType] ?? eventType.replace(/_/g, " ");
}

export interface CorrelationEmailContent {
  subject: string;
  body: string;
}

const FAMILY_LABELS: Record<string, string> = {
  FUNDING: "repeated funding relationship",
  TRANSFER_RELATIONSHIP: "repeated direct transfers",
  COUNTERPARTY_OVERLAP: "shared uncommon counterparties",
  ENTITY_OVERLAP: "shared verified entity",
  BEHAVIORAL_SIMILARITY: "behavioral similarity",
  PROTOCOL_SEQUENCE_SIMILARITY: "shared protocol usage",
  TEMPORAL_CORRELATION: "timing correlation",
  ASSET_FLOW_CORRELATION: "asset flow correlation"
};

function familyLine(family: string): string {
  return FAMILY_LABELS[family] ?? family.replace(/_/g, " ").toLowerCase();
}

/**
 * Builds the concise, epistemically safe correlation-alert email (§10).
 * Content stays inspectable: event type, monitored + related wallet,
 * previous/new strength, confidence, high-level evidence changes, timestamp,
 * compare link, and the standing correlation limitation.
 */
export function buildCorrelationEmail(input: {
  candidate: CorrelationChangeCandidate;
  monitoredWallet: string;
  timestamp?: string;
  appUri?: string;
}): CorrelationEmailContent {
  const { candidate, monitoredWallet } = input;
  const timestamp = input.timestamp ?? new Date().toISOString();
  const appUri = input.appUri ?? "https://aegix.app";

  const lines: string[] = [];
  lines.push("AEGIX Privacy Alert");
  lines.push("");
  lines.push(`${correlationEventLabel(candidate.eventType)}`);
  lines.push("");
  lines.push(`Monitored wallet: ${shortWallet(monitoredWallet)}`);
  lines.push(`Related wallet: ${shortWallet(candidate.relatedWallet)}`);
  lines.push("");
  if (candidate.previousScore !== null && candidate.newScore !== null) {
    lines.push(`Correlation strength: ${candidate.previousScore} → ${candidate.newScore}`);
  } else if (candidate.newScore !== null) {
    lines.push(`Correlation strength: ${candidate.newScore}`);
  } else if (candidate.previousScore !== null) {
    lines.push(`Previous correlation strength: ${candidate.previousScore}`);
  }
  if (candidate.newConfidence !== null) {
    lines.push(`Confidence: ${Math.round(candidate.newConfidence * 100)}%`);
  }
  lines.push("");
  lines.push("What changed (observed evidence):");
  lines.push(candidate.summary);
  const evidence = candidate.evidence as { addedFamilies?: string[]; removedFamilies?: string[]; families?: string[]; newFamilies?: string[] };
  const added = evidence.addedFamilies?.length ? evidence.addedFamilies : evidence.newFamilies;
  if (added && added.length > 0) {
    lines.push(`- new evidence: ${added.map(familyLine).join(", ")}`);
  }
  if (evidence.removedFamilies?.length) {
    lines.push(`- evidence no longer observed: ${evidence.removedFamilies.map(familyLine).join(", ")}`);
  }
  if (!added && !evidence.removedFamilies && evidence.families?.length) {
    lines.push(`- evidence families: ${evidence.families.map(familyLine).join(", ")}`);
  }
  lines.push("");
  lines.push(`Time: ${timestamp}`);
  lines.push(`View comparison: ${appUri}/compare?walletA=${encodeURIComponent(monitoredWallet)}&walletB=${encodeURIComponent(candidate.relatedWallet)}`);
  lines.push("");
  lines.push("AEGIX reports observable blockchain correlation. Correlation does not prove common ownership or real-world identity.");

  return {
    subject: `AEGIX Privacy Alert — ${correlationEventLabel(candidate.eventType).toLowerCase()}`,
    body: lines.join("\n")
  };
}
