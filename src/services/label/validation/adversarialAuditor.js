import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";

// §14.1. Deliberately narrow input: labelData + rules + confirmed product
// facts ONLY — never the generator's prompt, its reasoning, or which
// references it saw. An auditor that can see the generator's justification
// just re-derives the generator's own blind spots instead of finding new ones.
const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          status: { type: "string", enum: ["PASS", "FAIL", "WARN"] },
          reasoning: { type: "string" },
        },
        required: ["path", "status", "reasoning"],
      },
    },
  },
  required: ["verdicts"],
};

export async function audit(labelData, { rules = [], confirmedFacts = {} } = {}) {
  const ruleList = rules.map((r) => `- ${r.ruleKey}: ${r.description} (citation: "${r.citation}")`).join("\n") || "(none)";

  const prompt = `
You are an independent, adversarial auditor for a veterinary/animal-feed product label. Your ONLY job is to find reasons this label should FAIL. You did not write it and have no stake in it being approved.

=== LABEL CONTENT ===
${JSON.stringify(labelData, null, 2)}

=== REGULATORY RULES THAT APPLY ===
${ruleList}

=== CONFIRMED PRODUCT FACTS (ground truth — the label must not contradict these) ===
${JSON.stringify(confirmedFacts, null, 2)}

For each field below, give your independent verdict: PASS, FAIL, or WARN, with a one-sentence reason. Be skeptical — look for missing safety information, internal inconsistencies, unsupported claims, and rule violations.
Fields to review: productName, activeIngredients, targetAnimalSpecies, aimOfUse, directionOfUse, withdrawalPeriod, storage, warnings, contraindications.

Return ONLY the JSON object matching the schema. No markdown, no commentary.
  `.trim();

  const response = await geminiClient.generateJson({
    ledger: { feature: "labels.audit" },
    model: MODELS.AUDITOR.id,
    contents: prompt,
    schema: AUDIT_SCHEMA,
    temperature: MODELS.AUDITOR.temperature,
    thinkingBudget: MODELS.AUDITOR.thinkingBudget,
    maxOutputTokens: 8192,
  });

  return Array.isArray(response.verdicts) ? response.verdicts : [];
}

/**
 * Pure comparison (§14.1's disagreement flow): agree PASS->PASS, agree
 * FAIL->FAIL (WARN treated as a soft-FAIL for agreement purposes), anything
 * else is a disagreement to escalate. Never auto-resolved — a human decides
 * resolution (§14.1: "resolved in the auditor's favor" or "the engine's").
 */
export function compareVerdicts(engineVerdicts, auditorVerdicts) {
  const auditorByPath = new Map(auditorVerdicts.map((v) => [v.path, v]));
  const disagreements = [];

  for (const engineVerdict of engineVerdicts) {
    const auditorVerdict = auditorByPath.get(engineVerdict.path);
    if (!auditorVerdict) continue; // auditor didn't review this field — not a disagreement, just out of scope

    const engineFailed = engineVerdict.status === "FAIL";
    const auditorFailed = auditorVerdict.status === "FAIL" || auditorVerdict.status === "WARN";

    if (engineFailed !== auditorFailed) {
      disagreements.push({
        fieldPath: engineVerdict.path,
        deterministicVerdict: engineVerdict,
        auditorVerdict,
        auditorReasoning: auditorVerdict.reasoning,
      });
    }
  }
  return disagreements;
}
