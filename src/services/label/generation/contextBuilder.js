// §9.9's four isolated blocks, assembled in the order §9.7 requires for
// implicit caching: [regulatory rules] -> [schema] -> [references] -> [product
// data]. Large, shared-across-requests content first; the one thing that
// changes every call (product data) last. A company generating N labels for
// the same country pays for the regulatory+schema+reference tokens once.
import { geminiResponseSchema } from "../schema/geminiSchema.js";

export function buildRegulatoryBlock(rules) {
  if (!rules || rules.length === 0) {
    return `<REGULATORY>\nNO_AUTHORITATIVE_REQUIREMENTS — no approved regulatory rules exist yet for this country/product scope. Do not invent one; leave the corresponding fields for the validator to mark UNVERIFIABLE.\n</REGULATORY>`;
  }
  const lines = rules.map((r) => `- [${r.severity}] ${r.ruleKey} (${r.ruleType}${r.targetPath ? `, targetPath: ${r.targetPath}` : ""}): ${r.description}\n  Citation: "${r.citation}"`);
  return `<REGULATORY>\n${lines.join("\n")}\n</REGULATORY>`;
}

export function buildSchemaBlock() {
  return `<OUTPUT_SCHEMA>\nEnforced structurally via responseJsonSchema — this block exists only to name the constraint for the model's own reasoning, not to redefine it in prose.\nSchema: ${JSON.stringify(geminiResponseSchema).slice(0, 200)}... (full schema enforced by the API call, not repeated here to save tokens)\n</OUTPUT_SCHEMA>`;
}

export function buildReferenceBlock(rankedReferences) {
  if (!rankedReferences || rankedReferences.length === 0) {
    return `<REFERENCE_LABELS>\nNone available. Do not invent a style or borrow content from general knowledge as if it were a reference.\n</REFERENCE_LABELS>`;
  }
  const blocks = rankedReferences.map(({ reference, tier }, i) => {
    const validity =
      tier === "exact_combo" || tier === "ingredient"
        ? "Factual grounding permitted for aimOfUse/directionOfUse/storage/targetAnimalSpecies/indications/sideEffects/contraindications/warnings/feedClassification/routeOfAdministration — same or overlapping active ingredient(s). (Note: for the latter six, the field ladder already resolved what it could from this reference before you saw this prompt — GROUNDED FACTS below is authoritative; only use this reference directly for a field NOT already listed there.)"
        : "STYLE/FORMAT/PHRASING ONLY. This reference does NOT share this product's active ingredient(s) — do not copy any factual content (dosage, indications, species) from it.";
    return `--- Reference ${i + 1} (tier: ${tier}) ---\n${validity}\n${JSON.stringify(reference.extractedData || { fullText: reference.fullText }).slice(0, 2000)}`;
  });
  return `<REFERENCE_LABELS>\n${blocks.join("\n\n")}\n</REFERENCE_LABELS>`;
}

export function buildProductDataBlock(profile) {
  return `<PRODUCT_DATA>\nThis is the ABSOLUTE TRUTH for this specific product — it overrides any reference or general knowledge:\n${JSON.stringify(
    {
      productType: profile.productType,
      activeIngredients: profile.activeIngredients,
      targetSpecies: profile.targetSpecies,
      dosageForm: profile.dosageForm,
      routeOfAdministration: profile.routeOfAdministration,
      strength: profile.strength,
      withdrawalPeriod: profile.withdrawalPeriod,
      registrationNumber: profile.registrationNumber,
      country: profile.country,
      language: profile.language,
      confirmedFacts: profile.confirmedFacts,
      formulationText: profile.formulationText,
    },
    null,
    2
  )}\n</PRODUCT_DATA>`;
}

/**
 * Concatenates the four blocks in the cache-friendly order. Returns the prompt
 * string plus a promptHash-able fingerprint of the STABLE prefix (regulatory +
 * schema + references) separately from the variable product-data suffix, so
 * generationMeta can record what was actually cached vs. what changes every call.
 */
export function buildContext({ rules, rankedReferences, profile }) {
  const stablePrefix = [buildRegulatoryBlock(rules), buildSchemaBlock(), buildReferenceBlock(rankedReferences)].join("\n\n");
  const variableSuffix = buildProductDataBlock(profile);
  return { prompt: `${stablePrefix}\n\n${variableSuffix}`, stablePrefix, variableSuffix };
}
