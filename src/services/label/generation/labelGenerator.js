import crypto from "crypto";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { geminiResponseSchema } from "../schema/geminiSchema.js";
import { buildContext } from "./contextBuilder.js";
import { resolveGroundedFields } from "./fieldLadder.js";
import { resolve as resolveKnowledge } from "../knowledge/knowledgeResolver.js";
import { GROUNDED_CONTENT_FIELDS } from "./groundingPolicy.js";

// Deterministic target species union (ported from the pre-Phase-4 worker,
// which the architecture doc's own audit called out as "✅ genuinely works
// well" — the model never decides this, code does). Tier 1/2 (confirmedFacts,
// from Product row OR user hint) outranks Tier 4 (matched reference), which
// outranks Tier 5 (cited external lookup), which outranks Tier 6 (model's own
// inference, must be flagged in estimatedFields).
async function resolveTargetAnimalsSource(profile, matchedReferences) {
  if (profile.confirmedFacts.targetSpecies?.length > 0) {
    return { source: "confirmed", list: profile.confirmedFacts.targetSpecies };
  }
  const referenceTiers = matchedReferences.filter((r) => r.tier === "exact_combo" || r.tier === "ingredient");
  if (referenceTiers.length > 0) {
    const seen = new Map();
    for (const { reference } of referenceTiers) {
      const species = reference.extractedData?.target_animal_species;
      if (Array.isArray(species)) {
        for (const sp of species) {
          const key = (sp || "").toLowerCase().trim();
          if (key && !seen.has(key)) seen.set(key, sp.trim());
        }
      }
    }
    if (seen.size > 0) return { source: "reference", list: [...seen.values()] };
  }

  // Tier 5 — no confirmed fact, no matched reference. Try a cited lookup
  // before falling back to the model's own uncited inference.
  const ingredientNames = (profile.activeIngredients || []).map((i) => i.normalizedName).filter(Boolean).sort();
  if (ingredientNames.length > 0) {
    const lookupKey = `${ingredientNames.join("+")}|target_animal_species`;
    const cached = await resolveKnowledge("product_dossier", lookupKey, {
      fieldPath: "targetAnimalSpecies",
      searchFn: async (lk, kind) => {
        const prompt = `
Find the approved/labeled target animal species for a veterinary/animal-feed product with active ingredient(s): ${ingredientNames.join(", ")}.
Search only reputable regulatory/pharmacopoeial sources (EMA, FDA/ANADA, EDA, SFDA, VICH, WHO/WOAH, USP/Ph.Eur).
Respond with ONLY a raw JSON object (no markdown):
{ "found": true|false, "summary": "comma-separated species list, empty if found=false", "payload": {} }
Set found:false if you cannot locate a genuinely authoritative source — do not fabricate or guess.
        `.trim();
        const response = await geminiClient.generateContentWithRetry({
          model: MODELS.WEB_SEARCH.id,
          contents: prompt,
          config: { temperature: 0, tools: [{ googleSearch: {} }] },
        });
        const text = response.text || "";
        const annotations = response.candidates?.[0]?.groundingMetadata?.groundingSupports?.map((s) => s.segment) || [];
        let parsed;
        try {
          parsed = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
        } catch {
          return { found: false };
        }
        if (!parsed.found) return { found: false };
        const { acceptGroundedClaim } = await import("../knowledge/knowledgeResolver.js");
        const citations = annotations.map((a) => acceptGroundedClaim({ url: a.url, start_index: a.startIndex, end_index: a.endIndex }, text)).filter(Boolean);
        return { found: citations.length > 0, summary: parsed.summary, payload: parsed.payload, citations };
      },
    });
    if (cached?.summary) {
      const list = cached.summary.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
      if (list.length > 0) return { source: "external", list };
    }
  }

  return { source: "inferred", list: null }; // model must supply its own best inference — flagged in estimatedFields
}

// Hard backstop for Invariant #5/§8.2's absolute exclusions — enforced in
// CODE after generation, not just requested in the prompt. A field the model
// filled without a Tier 1/2/4 justification is nulled, never trusted as-is.
function enforceGroundingPolicy(labelData, { profile, matchedReferences }) {
  const refused = [];
  const hasGroundedReference = matchedReferences.some((r) => r.tier === "exact_combo" || r.tier === "ingredient");

  // Invariant #5 / CLAUDE.md: "Refusing beats guessing." An ungrounded
  // NEVER_GUESS value used to be left in labelData (only "refused" in name,
  // via estimatedFields) — that is exactly the fabricated-withdrawal-period/
  // strength/registration-number risk the invariant exists to prevent. Now
  // the value is actually nulled, not just flagged.
  const guard = (path, profileValue, getter, setter) => {
    const value = getter(labelData);
    if (value === null || value === undefined) return;
    const grounded = !!profileValue || hasGroundedReference;
    if (!grounded) {
      setter(labelData, null);
      refused.push(path);
    }
  };

  guard("withdrawalPeriod", profile.withdrawalPeriod, (l) => l.withdrawalPeriod, (l, v) => (l.withdrawalPeriod = v));
  guard("strength", profile.strength, (l) => l.strength, (l, v) => (l.strength = v));
  guard("registrationNumber", profile.registrationNumber, (l) => l.registrationNumber, (l, v) => (l.registrationNumber = v));
  guard("batchNo", null, (l) => l.batchNo, (l, v) => (l.batchNo = v)); // batch/production data — never derivable from formulation text or a reference
  guard("expiryDate", null, (l) => l.expiryDate, (l, v) => (l.expiryDate = v));

  // activeIngredients[].amount: must be traceable to the profile's own stated
  // ingredients (Tier 1/3 — the manufacturer's own formulation, copied
  // verbatim) or "q.s." — never a bare model estimate.
  const profileAmounts = new Set((profile.activeIngredients || []).map((i) => (i.amount || "").toString().trim().toLowerCase()).filter(Boolean));
  const formulationText = (profile.formulationText || "").toLowerCase();
  (labelData.activeIngredients || []).forEach((ing, i) => {
    const amount = (ing.amount || "").trim();
    if (!amount || amount.toLowerCase() === "q.s.") return;
    const grounded = profileAmounts.has(amount.toLowerCase()) || formulationText.includes(amount.toLowerCase());
    if (!grounded) {
      ing.amount = "q.s."; // schema requires a non-empty amount — "q.s." is the designated placeholder for "not stated", never a guessed number
      refused.push(`activeIngredients[${i}].amount`);
    }
  });

  return refused;
}

/**
 * The single constrained generation call (§4.1's labelGenerator.js). Output
 * is forced to labelSchema's shape via responseJsonSchema — no free-text
 * post-processing pass needed to coerce structure.
 */
export async function generate({ profile, rankedReferences = [], rules = [] }) {
  const { prompt, stablePrefix } = buildContext({ rules, rankedReferences, profile });
  const { source: targetAnimalsSource, list: resolvedSpeciesList } = await resolveTargetAnimalsSource(profile, rankedReferences);

  // §8.2's ladder, run for real, before the model ever sees the prompt — Tier
  // 1/2 (confirmedFacts), Tier 4 (matched reference's own extracted text),
  // Tier 5 (cited external lookup). Whatever comes back here is handed to the
  // model as fact, not left for it to "estimate".
  const groundedFacts = await resolveGroundedFields({ profile, rankedReferences });
  const contentFields = GROUNDED_CONTENT_FIELDS.filter((f) => f !== "targetAnimalSpecies");
  const unresolvedContentFields = contentFields.filter((f) => !groundedFacts[f]);
  // directionOfUse/storage are non-nullable in labelSchema (every label needs
  // some instruction/storage text to be usable) — every other grounded-content
  // field is nullable/array-default and can genuinely stay empty.
  const mustStillWrite = unresolvedContentFields.filter((f) => f === "directionOfUse" || f === "storage");
  const leaveEmpty = unresolvedContentFields.filter((f) => f !== "directionOfUse" && f !== "storage");

  const speciesInstruction = resolvedSpeciesList
    ? `targetAnimalSpecies.list MUST be exactly this set (translated), nothing added or dropped: ${resolvedSpeciesList.join(", ")}. Set targetAnimalSpecies.source to "${targetAnimalsSource}".`
    : `No confirmed, reference-matched, or cited target species exists. Infer your single best, scientifically-grounded answer from the active ingredient(s) and formulation. Set targetAnimalSpecies.source to "inferred" and add "targetAnimalSpecies" to estimatedFields.`;

  const groundedFactsBlock = Object.keys(groundedFacts).length === 0
    ? ""
    : `\nGROUNDED FACTS (§8.2 — Tier 1/2/4/5, already resolved in code, NOT for you to invent):\n${Object.entries(groundedFacts)
        .map(([field, fact]) => `- ${field} (tier ${fact.tier}, ${fact.provenance}): "${fact.value}"`)
        .join("\n")}\nUse this text as the factual content for each named field — translate it faithfully into ar/en, do not alter its meaning, do not add claims it doesn't make.\n`;

  const fullPrompt = `${prompt}

TASK: Generate a complete, professional veterinary/animal-feed product label matching the enforced JSON schema exactly.

${speciesInstruction}
${groundedFactsBlock}
GROUNDING RULES (do not violate):
- withdrawalPeriod, strength, registrationNumber, batchNo, expiryDate, activeIngredients[].amount: use ONLY a confirmed value (product data above) or a matched reference. If none exists, leave the field null (or "q.s." for activeIngredients[].amount) — do NOT estimate a number or ID. These are never guessed, no matter how standard they seem.
${leaveEmpty.length > 0 ? `- ${leaveEmpty.join(", ")}: no confirmed source, matched reference, or citable authoritative source exists for these. Leave each as null (or an empty array, per its schema type) — do NOT guess from general knowledge, and do NOT add them to estimatedFields.` : ""}
${mustStillWrite.length > 0 ? `- ${mustStillWrite.join(", ")}: these are required fields with no confirmed/reference/cited source. Write brief, generic, non-product-specific safe-practice guidance ONLY (do not invent a specific number, temperature, or claim), and add their names to estimatedFields.` : ""}
- For purely stylistic/presentational fields with no confirmed source (e.g. productName phrasing, packaging wording, usageDeclaration boilerplate), give your best draft and add its name to estimatedFields — this class of field carries no regulatory-fact risk.
- No therapeutic/medical claims ("treats", "cures", "يعالج") in aimOfUse for non-drug product types.
- Every LocalizedText field needs both an "ar" and "en" entry in translations, plus a "primary" key that exists in translations.`;

  // Invariant #3: every field's provenance must carry a promptHash. Hashing
  // the exact, fully-assembled prompt (not just stablePrefix) means an
  // identical hash on a later replay (§14.7) is a strong claim: the same
  // rules + references + profile + instructions were sent, verbatim.
  const promptHash = crypto.createHash("sha256").update(fullPrompt, "utf8").digest("hex");

  const response = await geminiClient.generateContentWithRetry({
    model: MODELS.LABEL_GENERATE.id,
    contents: fullPrompt,
    config: {
      temperature: MODELS.LABEL_GENERATE.temperature,
      thinkingConfig: { thinkingBudget: MODELS.LABEL_GENERATE.thinkingBudget },
      responseMimeType: "application/json",
      responseJsonSchema: geminiResponseSchema,
    },
  });

  let labelData;
  try {
    labelData = JSON.parse(response.text);
  } catch (err) {
    throw new Error("Model returned invalid JSON despite a forced schema: " + err.message);
  }

  const refusedFields = enforceGroundingPolicy(labelData, { profile, matchedReferences: rankedReferences });

  // Backstop for GROUNDED_CONTENT_FIELDS that had no Tier 1/2/4/5 source: the
  // model was instructed to leave these empty rather than guess, but a prompt
  // instruction is not a guarantee — enforce it in code the same way
  // enforceGroundingPolicy backstops NEVER_GUESS_FIELDS.
  const EMPTY_VALUE = { sideEffects: null, contraindications: null, feedClassification: null, routeOfAdministration: null, indications: [], warnings: [] };
  for (const field of leaveEmpty) {
    const empty = EMPTY_VALUE[field];
    const current = labelData[field];
    const isEmpty = empty === null ? current === null || current === undefined : Array.isArray(current) && current.length === 0;
    if (!isEmpty) {
      labelData[field] = empty;
      refusedFields.push(field);
    }
  }

  // Tier 4/5 fills are real content the model did not invent, but they are
  // still not the manufacturer's own confirmed data — surfaced in
  // estimatedFields so a human reviews/signs off on them (approvalService.js
  // reads exactly this array).
  const groundedContentFields = Object.entries(groundedFacts)
    .filter(([, fact]) => fact.tier === 4 || fact.tier === 5)
    .map(([field]) => field);

  labelData.estimatedFields = [...new Set([...(labelData.estimatedFields || []), ...refusedFields, ...mustStillWrite, ...groundedContentFields])];

  return {
    labelData,
    generationMeta: {
      modelId: MODELS.LABEL_GENERATE.id,
      temperature: MODELS.LABEL_GENERATE.temperature,
      thinkingBudget: MODELS.LABEL_GENERATE.thinkingBudget,
      schemaVersion: "vet-label@2.0.0",
      promptHash,
      cachedTokens: response.usageMetadata?.cachedContentTokenCount || 0,
      usage: {
        input: response.usageMetadata?.promptTokenCount,
        output: response.usageMetadata?.candidatesTokenCount,
      },
      stablePrefixLength: stablePrefix.length,
      refusedUngroundedFields: refusedFields,
    },
    matchTier: rankedReferences[0]?.tier || "none",
    referenceLabelIds: rankedReferences.map((r) => r.reference.id),
    targetAnimalsSource,
    groundedFacts,
    unresolvedContentFields: leaveEmpty,
  };
}

export { enforceGroundingPolicy, resolveTargetAnimalsSource };
