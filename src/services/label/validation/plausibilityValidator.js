// Layer 6 (§10.1, §14.5.7) — "does this look right", not "is this internally
// consistent" (that's coherence, layer 4) and not "does this match a rule"
// (that's layer 3). Everything here needs knowledge from OUTSIDE the label —
// typical concentration ranges, dosing norms, ingredient compatibility,
// withdrawal-period norms for a substance class. That's the dividing line
// from coherence, not "deterministic vs AI".
//
// STRUCTURAL guarantee, not a convention: buildVerdict() is the only place a
// verdict is constructed in this file, and it computes `status` itself from
// `plausibilitySource` — there is no parameter, branch, or call site anywhere
// in this module that can produce "PASS" or "FAIL". Absence of a plausibility
// verdict is not evidence of safety; it only ever raises a question, never
// closes one. Like adversarialAuditor.js, this is async, not part of the
// synchronous validationEngine.validate() (layers 1-4) — it's invoked
// separately, the same way the audit endpoint is.
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { resolve as resolveKnowledge } from "../knowledge/knowledgeResolver.js";

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    suspicious: { type: "boolean" },
    reasoning: { type: "string" },
  },
  required: ["suspicious", "reasoning"],
};

async function defaultJudge(prompt) {
  return geminiClient.generateJson({
    model: MODELS.PLAUSIBILITY_JUDGE.id,
    contents: prompt,
    schema: JUDGE_SCHEMA,
    temperature: MODELS.PLAUSIBILITY_JUDGE.temperature,
    thinkingBudget: MODELS.PLAUSIBILITY_JUDGE.thinkingBudget,
  });
}

/**
 * status = plausibilitySource === "external" ? "WARN" : "NEEDS_REVIEW".
 * The discriminator keys off WHERE the observation came from, not how severe
 * it sounds — a cited claim is always WARN, an uncited one is always
 * NEEDS_REVIEW, regardless of how alarming either reads. Keying off severity
 * would hide exactly the signal this layer exists to carry: whether the user
 * is looking at something grounded or something the model just thinks.
 *
 * remediation.suggested is hardcoded null — plausibility never proposes a
 * value for any field, not just the five §8.2 fields. There's no branch here
 * that could set one, so nothing downstream needs to special-case them.
 */
function buildVerdict(path, message, { plausibilitySource, citation = null, sourceUrl = null }) {
  if (plausibilitySource !== "external" && plausibilitySource !== "model_knowledge") {
    throw new Error(`plausibilityValidator.buildVerdict: invalid plausibilitySource "${plausibilitySource}"`);
  }
  const status = plausibilitySource === "external" ? "WARN" : "NEEDS_REVIEW";
  return {
    path,
    label: { en: path, ar: path },
    status,
    presence: "PRESENT",
    severity: "warning",
    layer: "plausibility",
    comparison: "plausibility",
    ruleKey: `PLAUSIBILITY.${path.toUpperCase()}`,
    message,
    citation,
    sourceUrl,
    plausibilitySource,
    autoFixable: false,
    remediation: { action: "review", suggested: null, source: null },
  };
}

/**
 * Two-stage, shared by every check below:
 *   1. judgeFn asks "is this worth flagging at all" — a narrow yes/no with
 *      reasoning, no citation required. Not suspicious -> no verdict, silently.
 *   2. resolveFn (knowledgeResolver, §8.2-strict) tries to back the concern
 *      with a citable authoritative source. Found -> external/WARN. Not
 *      found -> the model's own opinion stands, but only as NEEDS_REVIEW,
 *      and the message says so explicitly (§14.5.7 case [ج]).
 */
async function assessPlausibility({ fieldPath, judgePrompt, knowledgeKind, lookupKey, judgeFn = defaultJudge, resolveFn = resolveKnowledge }) {
  const judgment = await judgeFn(judgePrompt);
  if (!judgment?.suspicious) return null;

  const cached = await resolveFn(knowledgeKind, lookupKey);
  if (cached) {
    const citation = Array.isArray(cached.citations) && cached.citations[0] ? cached.citations[0] : null;
    return buildVerdict(fieldPath, `${judgment.reasoning}${cached.summary ? ` (${cached.summary})` : ""}`, {
      plausibilitySource: "external",
      citation: citation?.url ?? cached.sourceUrls?.[0] ?? null,
      sourceUrl: cached.sourceUrls?.[0] ?? citation?.url ?? null,
    });
  }

  return buildVerdict(fieldPath, `${judgment.reasoning} — this is an unsourced observation, for human review only.`, {
    plausibilitySource: "model_knowledge",
  });
}

// §14.5.7 check 1: is a stated concentration unusual for this active
// ingredient + form?
async function checkConcentrationPlausibility(labelData, deps) {
  const results = [];
  for (const [index, ing] of (labelData.activeIngredients || []).entries()) {
    if (!ing.amount || ing.amount.trim().toLowerCase() === "q.s." || !ing.unit) continue;
    const form = Object.values(labelData.pharmaceuticalForm?.translations || {})[0] || "unspecified form";
    const name = ing.normalizedName || ing.primary;
    const lookupKey = `${(name || "").toLowerCase().trim()}|${form.toLowerCase().trim()}`;
    const verdict = await assessPlausibility({
      fieldPath: `activeIngredients[${index}].amount`,
      judgePrompt: `Is a concentration of ${ing.amount} ${ing.unit} of "${name}" in a "${form}" veterinary/animal-feed product unusual compared to typical formulations? Answer only from established pharmaceutical/nutritional knowledge — if you don't know, say suspicious:false rather than guessing.`,
      knowledgeKind: "ingredient_monograph",
      lookupKey,
      ...deps,
    });
    if (verdict) results.push(verdict);
  }
  return results;
}

// §14.5.7 check 2: is the stated dose plausible for the target species/weight?
async function checkDosePlausibility(labelData, deps) {
  if (!labelData.directionOfUse) return [];
  const dose = Object.values(labelData.directionOfUse.translations || {})[0];
  if (!dose) return [];
  const species = (labelData.targetAnimalSpecies?.list || []).join(", ") || "unspecified species";
  const verdict = await assessPlausibility({
    fieldPath: "directionOfUse",
    judgePrompt: `Is this dosing instruction plausible for ${species}: "${dose}"? Answer only from established veterinary dosing knowledge — if you don't know, say suspicious:false rather than guessing.`,
    knowledgeKind: "species_norm",
    lookupKey: `${species.toLowerCase()}|dose`,
    ...deps,
  });
  return verdict ? [verdict] : [];
}

// §14.5.7 check 3: known antagonism/incompatibility between active ingredients?
async function checkIngredientCompatibility(labelData, deps) {
  const names = (labelData.activeIngredients || []).map((i) => i.normalizedName || i.primary).filter(Boolean);
  if (names.length < 2) return [];
  const verdict = await assessPlausibility({
    fieldPath: "activeIngredients",
    judgePrompt: `Is there a known pharmacological/nutritional incompatibility or antagonism between these active ingredients combined in one product: ${names.join(", ")}? Answer only from established knowledge — if you don't know, say suspicious:false rather than guessing.`,
    knowledgeKind: "ingredient_monograph",
    lookupKey: names.map((n) => n.toLowerCase().trim()).sort().join("+"),
    ...deps,
  });
  return verdict ? [verdict] : [];
}

// §14.5.7 check 4: check only — this NEVER proposes a withdrawalPeriod value
// (§8.2, enforced structurally above, not by special-casing this field).
async function checkWithdrawalPeriodPlausibility(labelData, deps) {
  if (!labelData.withdrawalPeriod) return [];
  const stated = Object.values(labelData.withdrawalPeriod.translations || {})[0];
  if (!stated) return [];
  const names = (labelData.activeIngredients || []).map((i) => i.normalizedName || i.primary).filter(Boolean).join(", ");
  const verdict = await assessPlausibility({
    fieldPath: "withdrawalPeriod",
    judgePrompt: `Is this withdrawal period consistent with the active ingredient class: "${stated}" for a product containing ${names || "unstated ingredients"}? Answer only from established knowledge — if you don't know, say suspicious:false rather than guessing.`,
    knowledgeKind: "ingredient_monograph",
    lookupKey: `${names.toLowerCase()}|withdrawal_period`,
    ...deps,
  });
  return verdict ? [verdict] : [];
}

/**
 * Runs all four checks. Never called from validationEngine.validate() (layers
 * 1-4 are synchronous and deterministic on purpose) — invoked the same way
 * adversarialAuditor.audit() is: a separate, explicit call, not automatic on
 * every generation.
 */
export async function run(labelData, deps = {}) {
  const [concentration, dose, compatibility, withdrawal] = await Promise.all([
    checkConcentrationPlausibility(labelData, deps),
    checkDosePlausibility(labelData, deps),
    checkIngredientCompatibility(labelData, deps),
    checkWithdrawalPeriodPlausibility(labelData, deps),
  ]);
  return [...concentration, ...dose, ...compatibility, ...withdrawal];
}

export { buildVerdict, assessPlausibility };
