import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { labelSchema } from "../schema/labelSchema.js";

const KNOWN_CONSTRAINT_KINDS = ["required_field", "forbidden_content", "format", "conditional", "value_constraint", "language_set", "semantic"];
const LABEL_SCHEMA_TOP_LEVEL_PATHS = new Set(Object.keys(labelSchema.shape));

// A targetPath may be a top-level field ("aimOfUse"), a dotted nested path
// ("targetAnimalSpecies.list"), or a wildcard array path
// ("activeIngredients[*].amount") per §7.3. Full structural validation against
// nested Zod shapes is more than this phase needs — checking the top-level
// segment exists on labelSchema is what actually prevents the failure mode this
// guards against: a rule referencing a field that doesn't exist in the schema
// at all (a typo, or a field from an earlier/later schema version).
export function isValidTargetPath(targetPath) {
  if (!targetPath) return true; // some rule types (e.g. language_set with appliesTo:"*") have no single targetPath
  const topSegment = targetPath.split(/[.[]/)[0];
  return LABEL_SCHEMA_TOP_LEVEL_PATHS.has(topSegment);
}

// "Verbatim" tolerates whitespace/newline differences from PDF extraction
// (a real PDF-to-text pass reflows text unpredictably) but not paraphrasing —
// every word must appear in order in the source.
function normalizeForCitationCheck(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function citationExistsVerbatim(citation, documentText) {
  if (!citation || !citation.trim()) return false;
  return normalizeForCitationCheck(documentText).includes(normalizeForCitationCheck(citation));
}

/**
 * Validates one AI-proposed rule against the source document and labelSchema.
 * Returns { ok: true } or { ok: false, reason }. Pure — no AI call, fully
 * unit-testable (tests/regulatory.ingestion.test.js).
 */
export function validateProposedRule(candidate, documentText) {
  if (!candidate.ruleKey || !candidate.ruleType || !candidate.severity || !candidate.constraint) {
    return { ok: false, reason: "Missing required field (ruleKey/ruleType/severity/constraint)." };
  }
  if (!KNOWN_CONSTRAINT_KINDS.includes(candidate.constraint.kind)) {
    return { ok: false, reason: `Unsupported constraint.kind "${candidate.constraint.kind}".` };
  }
  if (!isValidTargetPath(candidate.targetPath)) {
    return { ok: false, reason: `targetPath "${candidate.targetPath}" is not a field in labelSchema.` };
  }
  // §7.4: "a rule whose citation cannot be verified verbatim in its source
  // document is REJECTED — not warned, not downgraded." No citation = reject.
  if (!citationExistsVerbatim(candidate.citation, documentText)) {
    return { ok: false, reason: "Citation not found verbatim in the source document." };
  }
  return { ok: true };
}

const RULE_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ruleKey: { type: "string", description: "e.g. EG.VET.TARGET_SPECIES.REQUIRED" },
          ruleType: { type: "string", enum: ["required_field", "forbidden_content", "format", "conditional", "value_constraint", "language_set", "semantic"] },
          severity: { type: "string", enum: ["error", "warning", "info"] },
          targetPath: { type: ["string", "null"] },
          appliesWhen: { type: ["object", "null"] },
          constraint: { type: "object" },
          description: { type: "string" },
          citation: { type: "string", description: "MUST be copied verbatim from the source document — exact words, no paraphrasing" },
        },
        required: ["ruleKey", "ruleType", "severity", "constraint", "description", "citation"],
      },
    },
  },
  required: ["rules"],
};

/**
 * Compiles a regulatory document's full text into RegulatoryRule candidates.
 * The WHOLE document goes in one call — never chunked (§9.4): conditional
 * clauses and cross-references break when split.
 *
 * Returns { accepted: [...], rejected: [{ candidate, reason }] } — rejected
 * rules are never persisted; the caller (regulatoryDocumentService) is
 * responsible for that, and for reporting the rejection count.
 */
export async function compile(documentText, { title, authority, country } = {}) {
  const prompt = `
You are compiling a regulatory document into machine-checkable rules for a veterinary/animal-feed label validation system.

Document: "${title || "Untitled"}" — Authority: ${authority || "Unknown"} — Country: ${country || "Unknown"}

=== FULL SOURCE DOCUMENT TEXT ===
${documentText}
=== END SOURCE DOCUMENT TEXT ===

For EVERY normative clause (a requirement, prohibition, or conditional obligation — not a preamble, definition, or informational note), produce one rule object.

CRITICAL RULES:
1. "citation" MUST be copied VERBATIM (exact words, in order) from the document text above. Do not paraphrase or summarize it. A rule you cannot support with an exact quote should not be produced at all.
2. "targetPath" MUST be a field name from this list (or a dotted/bracketed path into one): ${[...LABEL_SCHEMA_TOP_LEVEL_PATHS].join(", ")}. If a clause doesn't map to any of these fields, omit targetPath (null) rather than guessing one.
3. "constraint.kind" MUST be exactly one of: required_field, forbidden_content, format, conditional, value_constraint, language_set, semantic. Use "semantic" only for a genuinely subjective judgement call (e.g. "is this claim misleading") that cannot be checked mechanically.
4. Use "conditional" for any rule that only applies under a condition (e.g. only for certain species) — shape: { "kind": "conditional", "when": { "path": "...", "anyOf": [...] }, "then": { <nested constraint> } }.
5. Use "forbidden_content" for prohibited claims/wording — shape: { "kind": "forbidden_content", "path": "...", "patterns": ["regex1", "regex2"], "flags": "i" }.

Return ONLY the JSON object matching the schema. No markdown, no commentary.
  `.trim();

  const response = await geminiClient.generateJson({
    model: MODELS.RULE_COMPILE.id,
    contents: prompt,
    schema: RULE_SCHEMA,
    temperature: MODELS.RULE_COMPILE.temperature,
    thinkingBudget: MODELS.RULE_COMPILE.thinkingBudget,
    maxOutputTokens: 32768,
  });

  const candidates = Array.isArray(response.rules) ? response.rules : [];
  const accepted = [];
  const rejected = [];

  for (const candidate of candidates) {
    const result = validateProposedRule(candidate, documentText);
    if (result.ok) accepted.push(candidate);
    else rejected.push({ candidate, reason: result.reason });
  }

  return { accepted, rejected };
}
