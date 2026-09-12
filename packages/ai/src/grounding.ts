import type { Finding, StructuredAnswer } from "./types.js";

export interface GroundingResult {
  answer: StructuredAnswer;
  /** Citations naming an ID AEGIX never issued for this context. */
  droppedReferences: number;
  /** Findings left with nothing behind them once those citations were removed. */
  droppedFindings: number;
}

/**
 * Validates an answer against the evidence that was actually supplied.
 *
 * A model asked for citations will sometimes produce plausible ones. The only
 * defence that holds is checking each against the set of IDs the
 * deterministic layer issued for this context, and removing what does not
 * match. A finding whose citations all fail is not weakened but unsupported,
 * so it is dropped rather than shown with a caveat.
 *
 * Both counts are returned rather than logged and forgotten: a rising
 * `droppedReferences` is how a degrading model becomes visible.
 */
export function enforceGrounding(answer: StructuredAnswer, knownIds: Iterable<string>): GroundingResult {
  const known = new Set(knownIds);
  let droppedReferences = 0;
  const kept: Finding[] = [];

  for (const finding of answer.findings) {
    const valid = finding.evidenceIds.filter((id) => known.has(id));
    droppedReferences += finding.evidenceIds.length - valid.length;
    if (valid.length > 0) kept.push({ statement: finding.statement, evidenceIds: valid });
  }

  const droppedFindings = answer.findings.length - kept.length;
  const limitations = [...answer.limitations];
  if (droppedFindings > 0) {
    limitations.push(
      `${droppedFindings} statement(s) were removed because they cited evidence that does not exist in this analysis.`
    );
  }

  return {
    answer: { summary: answer.summary, findings: kept, limitations },
    droppedReferences,
    droppedFindings
  };
}
