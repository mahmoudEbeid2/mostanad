import crypto from "crypto";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { buildContext } from "./contextBuilder.js";
import { resolveGroundedFields } from "./fieldLadder.js";
import { resolve as resolveKnowledge } from "../knowledge/knowledgeResolver.js";
import { GROUNDED_CONTENT_FIELDS, NEVER_GUESS_FIELDS, estimateBasisFor } from "./groundingPolicy.js";
import { rejectUnknownKeys } from "../schema/composer.js";

// NEVER_GUESS_FIELDS scalars that can genuinely be backed by a matched
// reference or a cited external lookup (Tier 4/5) — batchNo/expiryDate/
// shelfLifeAfterOpening are excluded from the ladder call itself (not just
// expected to miss it): they're manufacturing/stability data no reference
// label or regulatory document could ever state, so Tier 4/5 would be the
// wrong KIND of source for them, not just an unproven one (groundingPolicy.js).
// They go straight from "no profile value" to Tier 6.
const NEVER_GUESS_LADDER_FIELDS = ["withdrawalPeriod", "strength", "registrationNumber"];

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
          ledger: { feature: "labels.generation" },
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

// Amended Invariant #5 ("every field is generated — none render blank",
// CLAUDE.md). This NO LONGER nulls anything — the model's value is trusted
// as-is (the schema no longer allows null for these fields, see labelSchema.js).
// Its job now is purely to CLASSIFY why each never-guess field's value should
// be trusted (tier 1/4/5, real source) vs. must be flagged as a Tier 6
// estimate — never silently indistinguishable from a sourced value. Returns
// { estimated: string[], grounded: { [path]: {tier, provenance, sourceRef,
// citation, sourceUrl} } } — labelGeneratorWorker's buildFieldProvenance
// consumes both to build labelProvenance; `estimated` also lands in
// labelData.estimatedFields so approvalService's signedEstimatedFields gate
// picks it up with zero changes there.
function classifyNeverGuessFields(labelData, { profile, groundedNeverGuessFacts = {} }) {
  const estimated = [];
  const grounded = {};

  const classify = (path, profileValue) => {
    if (profileValue) {
      grounded[path] = { tier: 1, provenance: "confirmed", sourceRef: { kind: "product_row", field: path } };
      return;
    }
    const fact = groundedNeverGuessFacts[path];
    if (fact) {
      grounded[path] = { tier: fact.tier, provenance: fact.provenance, sourceRef: fact.sourceRef, citation: fact.citation, sourceUrl: fact.sourceUrl };
      return;
    }
    estimated.push(path);
  };

  classify("withdrawalPeriod", profile.withdrawalPeriod);
  classify("strength", profile.strength);
  classify("registrationNumber", profile.registrationNumber);
  // batchNo/expiryDate/shelfLifeAfterOpening: never on the profile, never
  // ladder-eligible (see NEVER_GUESS_LADDER_FIELDS comment) — always Tier 6
  // when generated, which is expected, not a bug.
  classify("batchNo", null);
  classify("expiryDate", null);
  classify("shelfLifeAfterOpening", null);

  // activeIngredients[].amount: traceable to the profile's own stated
  // ingredients or formulation text (Tier 1/3, the manufacturer's own
  // formulation) is trusted outright; anything else is the model's own
  // estimate — kept as the model wrote it (no more forcing to "q.s."),
  // flagged so a human reviews the actual number before it's printed.
  const profileAmounts = new Set((profile.activeIngredients || []).map((i) => (i.amount || "").toString().trim().toLowerCase()).filter(Boolean));
  const formulationText = (profile.formulationText || "").toLowerCase();
  (labelData.activeIngredients || []).forEach((ing, i) => {
    const amount = (ing.amount || "").trim().toLowerCase();
    const path = `activeIngredients[${i}].amount`;
    if (amount === "q.s." || (profileAmounts.has(amount) && amount)) {
      grounded[path] = { tier: profileAmounts.has(amount) ? 1 : 3, provenance: profileAmounts.has(amount) ? "confirmed" : "extracted" };
    } else if (amount && formulationText.includes(amount)) {
      grounded[path] = { tier: 3, provenance: "extracted" };
    } else {
      estimated.push(path);
    }
  });

  return { estimated, grounded };
}

/**
 * The single constrained generation call (§4.1's labelGenerator.js). Output
 * is forced to labelSchema's shape via responseJsonSchema — no free-text
 * post-processing pass needed to coerce structure.
 */
export async function generate({ profile, rankedReferences = [], rules = [], composedFields = null, discriminants = {} }) {
  const { prompt, stablePrefix, schema: responseSchema } = buildContext({ rules, rankedReferences, profile, composedFields });
  const { source: targetAnimalsSource, list: resolvedSpeciesList } = await resolveTargetAnimalsSource(profile, rankedReferences);

  // §8.2's ladder, run for real, before the model ever sees the prompt — Tier
  // 1/2 (confirmedFacts), Tier 4 (matched reference's own extracted text),
  // Tier 5 (cited external lookup). Whatever comes back here is handed to the
  // model as fact, not left for it to "estimate". Amended Invariant #5:
  // NEVER_GUESS_LADDER_FIELDS now runs through this SAME ladder (withdrawalPeriod/
  // strength/registrationNumber can be Tier 4/5-backed, not just Tier 1/refused) —
  // merged into one groundedFacts map so the prompt treats both classes identically.
  const [contentGroundedFacts, neverGuessGroundedFacts] = await Promise.all([
    resolveGroundedFields({ profile, rankedReferences }),
    resolveGroundedFields({ profile, rankedReferences, fields: NEVER_GUESS_LADDER_FIELDS }),
  ]);
  const groundedFacts = { ...contentGroundedFacts, ...neverGuessGroundedFacts };
  const contentFields = GROUNDED_CONTENT_FIELDS.filter((f) => f !== "targetAnimalSpecies");
  const unresolvedContentFields = contentFields.filter((f) => !contentGroundedFacts[f]);
  const unresolvedNeverGuessFields = NEVER_GUESS_FIELDS.filter((f) => f !== "activeIngredients[].amount" && !profile[f] && !neverGuessGroundedFacts[f]);

  const speciesInstruction = resolvedSpeciesList
    ? `targetAnimalSpecies.list MUST be exactly this set (translated), nothing added or dropped: ${resolvedSpeciesList.join(", ")}. Set targetAnimalSpecies.source to "${targetAnimalsSource}".`
    : `No confirmed, reference-matched, or cited target species exists. Infer your single best, scientifically-grounded answer from the active ingredient(s) and formulation. Set targetAnimalSpecies.source to "inferred" and add "targetAnimalSpecies" to estimatedFields.`;

  const groundedFactsBlock = Object.keys(groundedFacts).length === 0
    ? ""
    : `\nGROUNDED FACTS (§8.2 — Tier 1/2/4/5, already resolved in code — treat as CONFIRMED, do not contradict or re-derive):\n${Object.entries(groundedFacts)
        .map(([field, fact]) => `- ${field} (tier ${fact.tier}, ${fact.provenance}): "${fact.value}"`)
        .join("\n")}\nUse this text as the factual content for each named field — translate it faithfully into ar/en (skip translation for non-LocalizedText fields like registrationNumber), do not alter its meaning, do not add claims it doesn't make.\n`;

  // Amended Invariant #5 (CLAUDE.md, product owner decision): EVERY field —
  // including withdrawalPeriod/strength/registrationNumber/batchNo/expiryDate/
  // shelfLifeAfterOpening/activeIngredients[].amount — gets a real value now.
  // Nothing in this schema is nullable for these fields any more (labelSchema.js).
  // The distinction that used to be "refuse vs. fill" is now entirely about
  // provenance: classifyNeverGuessFields() (run after this call, in code) tags
  // anything not backed by GROUNDED FACTS above as a Tier 6 estimate, which
  // lands in estimatedFields and must be explicitly signed for at approval —
  // it does NOT block generation or get silently dropped.
  const fullPrompt = `${prompt}

TASK: Generate a complete, professional veterinary/animal-feed product label matching the enforced JSON schema exactly.

${speciesInstruction}
${groundedFactsBlock}
GROUNDING RULES (do not violate):
${unresolvedNeverGuessFields.length > 0 ? `- ${unresolvedNeverGuessFields.join(", ")}: no confirmed source, matched reference, or cited external lookup exists for these — they are safety/regulatory-identity fields, so give your most careful, reliable inference from the product's active ingredient(s), dosage form, product type, and species (real pharmacological/regulatory knowledge for this ingredient class, not a generic placeholder). Never leave them null or empty — a missing value on a printed label is worse than a flagged estimate. Every field you fill this way MUST be added to estimatedFields — this is mandatory for these fields, not optional, because a human reviewer must sign off on it before approval.` : ""}
${unresolvedContentFields.length > 0 ? `- ${unresolvedContentFields.join(", ")}: no confirmed source, matched reference, or citable authoritative source exists for these. Fill them with your own reliable inference from the product's active ingredient(s), dosage form, product type, and species — this is expected, not discouraged. Add every field you filled this way to estimatedFields so it gets human review.` : ""}
- activeIngredients[].amount with no confirmed/formulation-text backing: give your best reliable estimate rather than "q.s." — add "activeIngredients[N].amount" to estimatedFields for each one you estimated.
- For purely stylistic/presentational fields with no confirmed source (e.g. productName phrasing, packaging wording, usageDeclaration boilerplate), give your best draft and add its name to estimatedFields — this class of field carries no regulatory-fact risk.
- No therapeutic/medical claims ("treats", "cures", "يعالج") in aimOfUse for non-drug product types.
- Every LocalizedText field needs both an "ar" and "en" entry in translations, plus a "primary" key that exists in translations.`;

  // Invariant #3: every field's provenance must carry a promptHash. Hashing
  // the exact, fully-assembled prompt (not just stablePrefix) means an
  // identical hash on a later replay (§14.7) is a strong claim: the same
  // rules + references + profile + instructions were sent, verbatim.
  const promptHash = crypto.createHash("sha256").update(fullPrompt, "utf8").digest("hex");

  const response = await geminiClient.generateContentWithRetry({
    ledger: { feature: "labels.generation" },
    model: MODELS.LABEL_GENERATE.id,
    contents: fullPrompt,
    config: {
      temperature: MODELS.LABEL_GENERATE.temperature,
      thinkingConfig: { thinkingBudget: MODELS.LABEL_GENERATE.thinkingBudget },
      responseMimeType: "application/json",
      responseJsonSchema: responseSchema,
    },
  });

  let labelData;
  try {
    labelData = JSON.parse(response.text);
  } catch (err) {
    throw new Error("Model returned invalid JSON despite a forced schema: " + err.message);
  }

  // §3's closed-schema guarantee: a key in neither the core schema nor the
  // composed catalog fields is REJECTED and logged, never silently dropped or
  // silently kept (Invariant #7) — responseJsonSchema already constrains the
  // model's output shape, so this only ever fires on a genuinely unexpected
  // key (a schema/model mismatch bug), but it must still be enforced in code,
  // not assumed from the schema alone.
  let rejectedSchemaKeys = [];
  if (composedFields) {
    const { cleaned, rejectedKeys } = rejectUnknownKeys(labelData, composedFields);
    labelData = { ...cleaned };
    rejectedSchemaKeys = rejectedKeys;
  }

  // Amended Invariant #5: classify, never null. Returns which never-guess
  // paths are Tier 6 estimates (unresolved by profile/ladder) vs. which are
  // grounded (tier + provenance), for buildFieldProvenance in the worker.
  const { estimated: estimatedNeverGuessFields, grounded: groundedNeverGuessPaths } = classifyNeverGuessFields(labelData, { profile, groundedNeverGuessFacts: neverGuessGroundedFacts });

  // GROUNDED_CONTENT_FIELDS with no Tier 1/2/4/5 source: the model was invited
  // to infer a reliable value from product context (active ingredient class,
  // dosage form, species, product type) — this is a generation system, not a
  // lookup table, and requiring verbatim source text for every content field
  // left most labels with holes a competent formulator could fill correctly.
  // Whatever it actually wrote is classified here, not overwritten: still-
  // empty stays empty (Tier 6 -> UNVERIFIABLE at the provenance layer),
  // non-empty is flagged Tier 6 "inferred" and pushed into estimatedFields
  // for human review — never silently trusted as if it were grounded.
  const isFieldEmpty = (field) => {
    const value = labelData[field];
    return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
  };
  const modelInferredContentFields = unresolvedContentFields.filter((field) => !isFieldEmpty(field));

  // Tier 4/5 fills (content AND never-guess) are real content the model did
  // not invent, but they are still not the manufacturer's own confirmed data —
  // surfaced in estimatedFields so a human reviews/signs off on them
  // (approvalService.js reads exactly this array).
  const groundedTier45Fields = Object.entries(groundedFacts)
    .filter(([, fact]) => fact.tier === 4 || fact.tier === 5)
    .map(([field]) => field);

  labelData.estimatedFields = [...new Set([...(labelData.estimatedFields || []), ...estimatedNeverGuessFields, ...modelInferredContentFields, ...groundedTier45Fields])];

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
      estimatedNeverGuessFields,
      // Recorded so ruleOutcomeTracker's statistical downgrade (§7b) can
      // bucket this label's outcomes by the SAME discriminant combination the
      // schema was composed with — see generatedLabelService.js's
      // discriminants: label.generationMeta?.discriminants reads.
      discriminants,
      rejectedSchemaKeys,
    },
    matchTier: rankedReferences[0]?.tier || "none",
    referenceLabelIds: rankedReferences.map((r) => r.reference.id),
    targetAnimalsSource,
    groundedFacts,
    groundedNeverGuessPaths,
    // Only the genuinely-still-empty ones — a field the model filled via
    // reliable inference (modelInferredContentFields, now in estimatedFields)
    // is not UNVERIFIABLE, it's Tier 6/"inferred" and needs review, not a
    // refusal reason.
    unresolvedContentFields: unresolvedContentFields.filter(isFieldEmpty),
  };
}

export { classifyNeverGuessFields, resolveTargetAnimalsSource };
