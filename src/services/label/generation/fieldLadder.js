// §8.2's product resolution ladder, run field-by-field, for the content
// fields that a reference or an allowlisted authoritative source CAN back
// (GROUNDED_CONTENT_FIELDS in groundingPolicy.js) — as opposed to
// NEVER_GUESS_FIELDS, which no external source may ever fill.
//
// Before this module existed, labelGenerator.js asked the model for "your
// best scientifically-grounded estimate" on every empty field and called the
// result Tier 5/estimatedFields — but Tier 5 in §8.2 is specifically the
// cited ExternalKnowledgeCache lookup (knowledgeResolver.js), and that
// function was never imported by the generation path at all (only by
// plausibilityValidator.js, which flags suspicious content post-hoc — it
// doesn't fill anything). So every "Tier 5" value in a generated label was
// actually uncited model knowledge mislabeled as Tier 5. This module is what
// makes the ladder real: Tier 1/2 (confirmedFacts) -> Tier 4 (matched
// reference's own extracted text) -> Tier 5 (knowledgeResolver, cited) ->
// Tier 6 (null, caller must not invent).
import { resolve as resolveKnowledge } from "../knowledge/knowledgeResolver.js";
import { isNeverGuessField, GROUNDED_CONTENT_FIELDS } from "./groundingPolicy.js";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { acceptGroundedClaim } from "../knowledge/knowledgeResolver.js";

// Tier 4: where each field's factual text lives on a matched reference row.
// referenceLabelWorker.js's extraction schema has two generations of shape —
// the newer explicit top-level keys (side_effects, contraindications,
// feed_classification, route_of_administration), and the older free-text
// "sections" object every already-ingested reference has instead. Try the
// explicit key first, fall back to the section so existing references still
// ground something.
const REFERENCE_FIELD_SOURCES = {
  indications: (data) => data?.sections?.indications,
  directionOfUse: (data) => data?.sections?.dosage,
  storage: (data) => data?.sections?.storage,
  warnings: (data) => data?.sections?.warnings,
  sideEffects: (data) => data?.side_effects,
  contraindications: (data) => data?.contraindications,
  feedClassification: (data) => data?.feed_classification,
  routeOfAdministration: (data) => data?.route_of_administration,
};

const FIELD_SEARCH_TOPIC = {
  sideEffects: "known side effects / adverse reactions",
  indications: "approved indications for use",
  directionOfUse: "directions for use / dosage and administration instructions",
  storage: "storage conditions",
  contraindications: "contraindications",
  warnings: "warnings and precautions",
  feedClassification: "feed/regulatory classification (e.g. feed additive, premix, medicated feed)",
  routeOfAdministration: "route of administration",
};

function flattenText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value.filter(Boolean).join("; ").trim() || null;
  return null;
}

function referenceGroundedTier(rankedReferences) {
  return (rankedReferences || []).filter((r) => r.tier === "exact_combo" || r.tier === "ingredient");
}

function buildLookupKey(profile) {
  const names = (profile.activeIngredients || [])
    .map((i) => (i.normalizedName || "").toLowerCase().trim())
    .filter(Boolean)
    .sort()
    .join("+");
  return names || (profile.productType || "unknown_product");
}

// Tier 5 search function for one field — same shape as knowledgeResolver's
// defaultSearch, but asking specifically for this field's content rather
// than a generic lookup, so the citation actually backs the field it's
// attached to.
async function fieldSearch(lookupKey, kind, { fieldPath, profile }) {
  const ingredientList = (profile.activeIngredients || []).map((i) => i.normalizedName).filter(Boolean).join(", ") || "unknown";
  const prompt = `
Find the ${FIELD_SEARCH_TOPIC[fieldPath] || fieldPath} for a veterinary/animal-feed product with these active ingredient(s): ${ingredientList}.
Product type: ${profile.productType || "unknown"}. Dosage form: ${profile.dosageForm || "unknown"}.

Search only reputable regulatory/pharmacopoeial sources (EMA, FDA/ANADA, EDA, SFDA, VICH, WHO/WOAH, USP/Ph.Eur).
Respond with ONLY a raw JSON object (no markdown):
{ "found": true|false, "summary": "the ${fieldPath} text, plain language, empty if found=false", "payload": {} }
Set found:false if you cannot locate a genuinely authoritative source for THIS specific active ingredient/product type — do not fabricate or guess, and do not answer from general knowledge without a source.
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

  const citations = annotations
    .map((a) => acceptGroundedClaim({ url: a.url, start_index: a.startIndex, end_index: a.endIndex }, text))
    .filter(Boolean);

  return { found: citations.length > 0, summary: parsed.summary, payload: parsed.payload, citations };
}

/**
 * Resolves one field through §8.2's ladder. Returns null if unresolved
 * (caller's job is Tier 6: leave it empty, never invent) — otherwise
 * { value, tier, provenance, sourceRef, citation, sourceUrl }.
 */
export async function resolveGroundedField(fieldPath, { profile, rankedReferences = [] }) {
  if (isNeverGuessField(fieldPath)) {
    throw new Error(`fieldLadder.resolveGroundedField refused: "${fieldPath}" is a NEVER_GUESS field (Invariant #5) — it may not go through the external ladder at all.`);
  }

  // Tier 1/2: Product row or user hint, already merged into confirmedFacts by
  // buildProductProfile.
  const confirmed = flattenText(profile.confirmedFacts?.[fieldPath]);
  if (confirmed) {
    return { value: confirmed, tier: profile.provenance?.fromUserHints?.includes(fieldPath) ? 2 : 1, provenance: "confirmed", sourceRef: null, citation: null, sourceUrl: null };
  }

  // Tier 4: a matched reference's own extracted text — deterministic, not
  // asking the model to "remember" what a reference said.
  const getter = REFERENCE_FIELD_SOURCES[fieldPath];
  if (getter) {
    for (const { reference } of referenceGroundedTier(rankedReferences)) {
      const text = flattenText(getter(reference.extractedData));
      if (text) {
        return { value: text, tier: 4, provenance: "reference", sourceRef: { kind: "reference_label", ids: [reference.id] }, citation: null, sourceUrl: null };
      }
    }
  }

  // Tier 5: cited external lookup, cached 90 days. Never reached for a
  // NEVER_GUESS field (guarded above) and never invented without a citation
  // that survives the allowlist check (knowledgeResolver.acceptGroundedClaim).
  const lookupKey = `${buildLookupKey(profile)}|${fieldPath}`;
  const cached = await resolveKnowledge("product_dossier", lookupKey, {
    fieldPath,
    searchFn: (lk, kind) => fieldSearch(lk, kind, { fieldPath, profile }),
  });
  if (cached) {
    const citation = Array.isArray(cached.citations) && cached.citations[0] ? cached.citations[0] : null;
    return {
      value: cached.summary || null,
      tier: 5,
      provenance: "external",
      sourceRef: { kind: "external_knowledge_cache", id: cached.id },
      citation: citation?.quotedText ?? null,
      sourceUrl: cached.sourceUrls?.[0] ?? citation?.url ?? null,
    };
  }

  // Tier 6 — nothing found. Caller leaves the field empty; validation decides
  // FAIL/UNVERIFIABLE, never a fabricated value.
  return null;
}

/**
 * Runs the ladder for every field in GROUNDED_CONTENT_FIELDS except
 * targetAnimalSpecies (that field has its own array-shaped resolver in
 * labelGenerator.js — resolveTargetAnimalsSource — because its value is a
 * species list, not free text, and Tier 1/2/4 already fully cover it there).
 * Runs in parallel: Tier 1/2/4 are synchronous lookups, only genuinely
 * unresolved fields fall through to a Tier 5 Gemini call.
 */
export async function resolveGroundedFields({ profile, rankedReferences = [] }) {
  const fields = GROUNDED_CONTENT_FIELDS.filter((f) => f !== "targetAnimalSpecies");
  const entries = await Promise.all(
    fields.map(async (fieldPath) => [fieldPath, await resolveGroundedField(fieldPath, { profile, rankedReferences })])
  );
  return Object.fromEntries(entries.filter(([, result]) => result !== null));
}

export { REFERENCE_FIELD_SOURCES, FIELD_SEARCH_TOPIC };
