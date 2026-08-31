export { evaluateThreats, applyRules, eventFingerprint, severityAtLeast, SEVERITY_ORDER } from "./threat.js";
export type { EmailProvider, EmailInput } from "./email.js";
export { createEmailProvider, classifyEmailError, TransientEmailError, PermanentEmailError } from "./email.js";
export { runMonitorPipeline, deliverNotification } from "./pipeline.js";
export type { ProcessorContext } from "./types.js";
