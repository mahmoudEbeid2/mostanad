import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    clauses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          reference: { type: "string", description: "which paragraph/clause this is, e.g. 'Section 4.3' or a short quote" },
          isNormative: { type: "boolean", description: "true if this is a real requirement/prohibition, false if it's a preamble/definition/heading" },
          coveredByRuleKey: { type: ["string", "null"], description: "the ruleKey that covers this clause, or null if uncovered" },
          reasonIfUncovered: { type: ["string", "null"] },
        },
        required: ["reference", "isNormative", "coveredByRuleKey"],
      },
    },
  },
  required: ["clauses"],
};

/**
 * The reverse pass (§7.5): re-reads the WHOLE document against the rules
 * already compiled and asks "which normative clauses produced no rule, and
 * why?" A second LLM call auditing the first is a real limit, not proof — if
 * both passes share the same blind spot, coverage will overstate itself. Not
 * a substitute for human review, which is why §7.5's gate requires >=95%
 * AND (implicitly, via the review endpoints) a human to have seen the rest.
 */
export async function auditDocument(documentText, acceptedRules) {
  const ruleList = acceptedRules.map((r) => `- ${r.ruleKey}: "${r.citation}"`).join("\n");

  const prompt = `
You are auditing whether a rule-compilation pass over a regulatory document missed any normative clause.

=== FULL SOURCE DOCUMENT TEXT ===
${documentText}
=== END SOURCE DOCUMENT TEXT ===

=== RULES ALREADY COMPILED FROM THIS DOCUMENT ===
${ruleList || "(none)"}
=== END COMPILED RULES ===

Go through the document clause by clause (paragraph, numbered item, or table row). For each one, decide:
- isNormative: does it state a real requirement, prohibition, or conditional obligation? (A title, preamble, definition, or purely informational sentence is NOT normative.)
- coveredByRuleKey: if normative, which of the compiled rules above covers it (match by citation content)? null if none does.
- reasonIfUncovered: if normative and uncovered, briefly say why it wasn't captured (e.g. "table row not parsed", "conditional clause missed").

Return ONLY the JSON object matching the schema. No markdown, no commentary.
  `.trim();

  const response = await geminiClient.generateJson({
    model: MODELS.COVERAGE_AUDIT.id,
    contents: prompt,
    schema: AUDIT_SCHEMA,
    temperature: MODELS.COVERAGE_AUDIT.temperature,
    thinkingBudget: MODELS.COVERAGE_AUDIT.thinkingBudget,
    maxOutputTokens: 32768,
  });

  return computeCoverage(acceptedRules.length, Array.isArray(response.clauses) ? response.clauses : []);
}

/**
 * Pure — separated from auditDocument so the percentage/gate math is
 * unit-testable without an AI call. clauseTotal = accepted rules + normative
 * clauses the audit found uncovered (non-normative clauses never count).
 */
export function computeCoverage(acceptedRuleCount, auditedClauses) {
  const normativeClauses = auditedClauses.filter((c) => c.isNormative);
  const uncovered = normativeClauses.filter((c) => !c.coveredByRuleKey);
  const clauseTotal = acceptedRuleCount + uncovered.length;
  const clauseCovered = acceptedRuleCount;
  const coveragePercent = clauseTotal > 0 ? (clauseCovered / clauseTotal) * 100 : 100;

  return {
    clauseTotal,
    clauseCovered,
    coveragePercent,
    uncoveredClauses: uncovered.map((c) => ({ reference: c.reference, reason: c.reasonIfUncovered || null })),
  };
}

// §7.5's hard gate: a document may not be approved with coveragePercent < 95%
// unless every uncovered clause was explicitly reclassified by a human as
// non-normative first (i.e. uncoveredClauses is empty by the time of approval —
// a human cleared it via PATCH, not this function silently overriding the number).
export const MINIMUM_COVERAGE_PERCENT_FOR_APPROVAL = 95;
