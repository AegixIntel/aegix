export { evaluateThreats, applyRules, eventFingerprint, severityAtLeast, SEVERITY_ORDER } from "./threat.js";
export type { EmailProvider, EmailInput } from "./email.js";
export { createEmailProvider, classifyEmailError, TransientEmailError, PermanentEmailError } from "./email.js";
export {
  buildCorrelationEmail,
  correlationEmailEligibility,
  correlationEventLabel,
  shortWallet,
  type CorrelationEmailContent,
  type CorrelationEmailEligibility
} from "./notification-email.js";
export { runMonitorPipeline, deliverNotification } from "./pipeline.js";
export type { ProcessorContext } from "./types.js";
export {
  evaluateCorrelationChanges,
  applyCorrelationRules,
  correlationEventFingerprint,
  CORRELATION_MONITOR_ENGINE_VERSION,
  type CorrelationSnapshot,
  type CorrelationChangeCandidate,
  type CorrelationAlertConfig,
  type CorrelationEventType
} from "./correlation.js";
