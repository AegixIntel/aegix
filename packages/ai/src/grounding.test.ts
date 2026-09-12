import assert from "node:assert/strict";
import { test } from "node:test";
import { enforceGrounding } from "./grounding.js";
import type { StructuredAnswer } from "./types.js";

function answer(over: Partial<StructuredAnswer> = {}): StructuredAnswer {
  return { summary: "summary", findings: [], limitations: [], ...over };
}

test("a fabricated evidence id is removed", () => {
  const result = enforceGrounding(
    answer({ findings: [{ statement: "Funded repeatedly.", evidenceIds: ["ind:REPEATED_FUNDING", "ind:INVENTED"] }] }),
    ["ind:REPEATED_FUNDING"]
  );

  assert.deepEqual(result.answer.findings[0]?.evidenceIds, ["ind:REPEATED_FUNDING"]);
  assert.equal(result.droppedReferences, 1);
  assert.equal(result.droppedFindings, 0);
});

test("a finding left with no valid citation is dropped entirely", () => {
  const result = enforceGrounding(
    answer({ findings: [{ statement: "This wallet is operated by an exchange.", evidenceIds: ["ind:MADE_UP"] }] }),
    ["ind:REAL"]
  );

  assert.deepEqual(result.answer.findings, []);
  assert.equal(result.droppedFindings, 1);
  assert.equal(result.droppedReferences, 1);
});

test("dropping a finding is disclosed rather than hidden", () => {
  const result = enforceGrounding(
    answer({ findings: [{ statement: "Unsupported.", evidenceIds: ["ind:NOPE"] }] }),
    ["ind:REAL"]
  );

  assert.ok(result.answer.limitations.some((l) => l.includes("cited evidence that does not exist")));
});

test("grounded findings survive while uncited summary and limitations cannot bypass grounding", () => {
  const original = answer({
    findings: [{ statement: "Repeated funding observed.", evidenceIds: ["ind:A", "ind:B"] }],
    limitations: ["Bounded history."]
  });
  const result = enforceGrounding(original, ["ind:A", "ind:B"]);

  assert.deepEqual(result.answer.findings, original.findings);
  assert.equal(result.answer.summary, "Repeated funding observed.");
  assert.ok(!result.answer.limitations.includes("Bounded history."));
  assert.equal(result.droppedReferences, 0);
  assert.equal(result.droppedFindings, 0);
});

test("uncited invented summary and safety claims with valid citations are removed", () => {
  const result = enforceGrounding(answer({ summary: "The owner is a criminal.",
    findings: [{ statement: "This wallet is clean and safe.", evidenceIds: ["sig:A"] },
      { statement: "Funding observed.", evidenceIds: ["sig:A", "sig:A", "sig:unknown"] }],
    limitations: ["Buy SOL now."] }), ["sig:A"]);
  assert.equal(result.droppedFindings, 1);
  assert.equal(result.droppedReferences, 1);
  assert.equal(result.answer.summary, "Funding observed.");
  assert.deepEqual(result.answer.findings[0]!.evidenceIds, ["sig:A"]);
  assert.ok(!JSON.stringify(result.answer).includes("Buy SOL"));
});

test("only the ids supplied for this context count as known", () => {
  const result = enforceGrounding(
    answer({ findings: [{ statement: "From another analysis.", evidenceIds: ["ind:FROM_OTHER_WALLET"] }] }),
    ["ind:THIS_WALLET"]
  );

  assert.equal(result.answer.findings.length, 0);
});

test("partial grounding keeps the finding and the citations that hold", () => {
  const result = enforceGrounding(
    answer({
      findings: [
        { statement: "Kept.", evidenceIds: ["ind:A", "ind:GHOST"] },
        { statement: "Dropped.", evidenceIds: ["ind:GHOST2"] }
      ]
    }),
    ["ind:A"]
  );

  assert.deepEqual(result.answer.findings.map((f) => f.statement), ["Kept."]);
  assert.equal(result.droppedReferences, 2);
  assert.equal(result.droppedFindings, 1);
});
