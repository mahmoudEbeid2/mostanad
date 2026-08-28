import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

// SCOPE DEVIATION FROM §11.1: the doc specifies a full multi-tool agentic loop
// (getLabel/getValidationReport/getRule/searchReferences/getProvenance/
// getVersionHistory/dryRunPatch/proposePatch as separate model-invoked tool
// calls over several turns). This implements the same INTENT ROUTING (§11.2)
// and the same hard invariant (dryRunPatch before proposePatch — enforced in
// generatedLabelService.js's chat orchestration, in CODE, not by the agent's
// own discipline) with far fewer moving parts: one call classifies intent,
// one call answers a question/explanation with all relevant context already
// inlined (label + latest report + the specific rules it references), one
// call proposes a patch. This trades away multi-turn tool exploration (e.g.
// the agent deciding on its own to search references mid-conversation) for
// something that's actually finished and testable in this phase. Extending
// this to real Gemini function-calling with a tool loop is real future work,
// not done here — flagged in PROGRESS.md.

const INTENT_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: ["question", "explain_validation", "edit"] } },
  required: ["intent"],
};

export async function classifyIntent(message) {
  const response = await geminiClient.generateJson({
    model: MODELS.CHAT_AGENT.id,
    contents: `Classify this user message about an existing product label into exactly one intent.
- "question": asking about the label's current content (read-only).
- "explain_validation": asking why something failed/passed validation (read-only).
- "edit": asking to change the label's content.

Message: "${message}"`,
    schema: INTENT_SCHEMA,
    temperature: 0,
    thinkingBudget: 0, // classification is mechanical (§9.3: "minimal")
  });
  return response.intent;
}

export async function answerQuestion(message, { labelData, report, rules = [] }) {
  const relevantRules = rules.filter((r) => report?.verdicts?.some((v) => v.ruleKey === r.ruleKey && v.status === "FAIL"));
  const prompt = `
You are a regulatory affairs reviewer helping a colleague understand a product label — NOT generating or editing content, only explaining what's already there.

=== CURRENT LABEL ===
${JSON.stringify(labelData, null, 2)}

=== LATEST VALIDATION REPORT ===
${JSON.stringify(report?.verdicts || [], null, 2)}

=== RULES BEHIND ANY FAILURES ABOVE ===
${relevantRules.map((r) => `${r.ruleKey}: ${r.description}\nCitation: "${r.citation}"`).join("\n\n") || "(none)"}

User's question: "${message}"

Answer directly and specifically, citing the actual verdict/rule/citation where relevant. Do not propose any change — if the user actually wants an edit, say so and that they should ask for the change directly.
  `.trim();

  const response = await geminiClient.ai.models.generateContent({
    model: MODELS.LABEL_REVIEW.id,
    contents: prompt,
    config: { temperature: 0.2 },
  });
  return response.text;
}

const PATCH_SCHEMA = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          op: { type: "string", enum: ["replace", "append", "remove", "insert"] },
          value: {},
        },
        required: ["path", "op"],
      },
    },
  },
  required: ["rationale", "changes"],
};

export async function proposePatch(message, { labelData, report }) {
  const prompt = `
A user is requesting an edit to an existing product label. Produce a MINIMAL patch — only the fields that actually need to change, never a full label rewrite.

=== CURRENT LABEL ===
${JSON.stringify(labelData, null, 2)}

=== LATEST VALIDATION REPORT (context on existing issues) ===
${JSON.stringify(report?.verdicts?.filter((v) => v.status !== "PASS") || [], null, 2)}

User's edit request: "${message}"

Return a patch: { "rationale": "...", "changes": [{ "path": "...", "op": "replace|append|remove|insert", "value": ... }] }.
"path" addresses the exact labelSchema field (dotted/bracketed for nested/array, e.g. "targetAnimalSpecies.list" or "activeIngredients[0].amount") — never a bare top-level rewrite of an object that only needs one sub-field changed.
Return ONLY the JSON object. No markdown, no commentary.
  `.trim();

  return geminiClient.generateJson({
    model: MODELS.CHAT_AGENT.id,
    contents: prompt,
    schema: PATCH_SCHEMA,
    temperature: MODELS.CHAT_AGENT.temperature,
    thinkingBudget: MODELS.CHAT_AGENT.thinkingBudget,
  });
}
