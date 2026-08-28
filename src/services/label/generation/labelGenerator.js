import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { MODELS } from "../../ai/modelRegistry.js";
import { geminiResponseSchema } from "../schema/geminiSchema.js";
import { buildContext } from "./contextBuilder.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function callWithRetry(contents, config, retries = 5, delay = 5000) {
  while (retries > 0) {
    try {
      return await ai.models.generateContent({ model: MODELS.LABEL_GENERATE.id, contents, config });
    } catch (error) {
      const msg = error.message || "";
      const isQuotaOrDemand = ["503", "Service Unavailable", "429", "quota"].some((s) => msg.includes(s));
      if (isQuotaOrDemand && retries > 1) {
        retries--;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.floor(delay * 1.5);
      } else {
        throw error;
      }
    }
  }
}

// Deterministic target species union (ported from the pre-Phase-4 worker,
// which the architecture doc's own audit called out as "✅ genuinely works
// well" — the model never decides this, code does). Tier 1/2 (confirmedFacts,
// from Product row OR user hint) outranks Tier 4 (matched reference), which
// outranks Tier 6 (model's own inference, must be flagged in estimatedFields).
function resolveTargetAnimalsSource(profile, matchedReferences) {
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
  return { source: "inferred", list: null }; // model must supply its own best inference — flagged in estimatedFields
}

// Hard backstop for Invariant #5/§8.2's absolute exclusions — enforced in
// CODE after generation, not just requested in the prompt. A field the model
// filled without a Tier 1/2/4 justification is nulled, never trusted as-is.
function enforceGroundingPolicy(labelData, { profile, matchedReferences }) {
  const refused = [];
  const hasGroundedReference = matchedReferences.some((r) => r.tier === "exact_combo" || r.tier === "ingredient");

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
      ing.amount = "q.s.";
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
  const { source: targetAnimalsSource, list: resolvedSpeciesList } = resolveTargetAnimalsSource(profile, rankedReferences);

  const speciesInstruction = resolvedSpeciesList
    ? `targetAnimalSpecies.list MUST be exactly this set (translated), nothing added or dropped: ${resolvedSpeciesList.join(", ")}. Set targetAnimalSpecies.source to "${targetAnimalsSource}".`
    : `No confirmed or reference-matched target species exists. Infer your single best, scientifically-grounded answer from the active ingredient(s) and formulation. Set targetAnimalSpecies.source to "inferred" and add "targetAnimalSpecies" to estimatedFields.`;

  const fullPrompt = `${prompt}

TASK: Generate a complete, professional veterinary/animal-feed product label matching the enforced JSON schema exactly.

${speciesInstruction}

GROUNDING RULES (do not violate):
- withdrawalPeriod, strength, registrationNumber, batchNo, expiryDate: fill ONLY if <PRODUCT_DATA> states it directly or a reference above is tier "exact_combo"/"ingredient" and states it. Otherwise leave null — do NOT estimate these. A wrong guess here is a safety/legal risk, not a style choice.
- activeIngredients[].amount: copy VERBATIM from <PRODUCT_DATA>'s formulationText/activeIngredients. Never invent a number. Use "q.s." if none is stated.
- For every other field with no confirmed source, give your best scientifically-grounded estimate and add its name to estimatedFields — do not leave it vague or a bare "x".
- No therapeutic/medical claims ("treats", "cures", "يعالج") in aimOfUse for non-drug product types.
- Every LocalizedText field needs both an "ar" and "en" entry in translations, plus a "primary" key that exists in translations.`;

  // Invariant #3: every field's provenance must carry a promptHash. Hashing
  // the exact, fully-assembled prompt (not just stablePrefix) means an
  // identical hash on a later replay (§14.7) is a strong claim: the same
  // rules + references + profile + instructions were sent, verbatim.
  const promptHash = crypto.createHash("sha256").update(fullPrompt, "utf8").digest("hex");

  const response = await callWithRetry(fullPrompt, {
    temperature: MODELS.LABEL_GENERATE.temperature,
    thinkingConfig: { thinkingBudget: MODELS.LABEL_GENERATE.thinkingBudget },
    responseMimeType: "application/json",
    responseJsonSchema: geminiResponseSchema,
  });

  let labelData;
  try {
    labelData = JSON.parse(response.text);
  } catch (err) {
    throw new Error("Model returned invalid JSON despite a forced schema: " + err.message);
  }

  const refusedFields = enforceGroundingPolicy(labelData, { profile, matchedReferences: rankedReferences });
  labelData.estimatedFields = [...new Set([...(labelData.estimatedFields || []), ...refusedFields])];

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
  };
}

export { enforceGroundingPolicy, resolveTargetAnimalsSource };
