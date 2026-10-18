// §9.9's four isolated blocks, assembled in the order §9.7 requires for
// implicit caching: [regulatory rules] -> [schema] -> [references] -> [product
// data]. Large, shared-across-requests content first; the one thing that
// changes every call (product data) last. A company generating N labels for
// the same country pays for the regulatory+schema+reference tokens once.
import { geminiResponseSchema } from "../schema/geminiSchema.js";
import { toGeminiSchema } from "../schema/composer.js";

// §6 of the ingestion overhaul: "the catalog contributes which fields are
// required, under what condition, in what format and in which languages —
// ZERO values." composedFields (composer.buildLabelSchema's output) carries
// exactly that metadata for catalog-CONTRIBUTED fields (contributedBy.length
// > 0 — pure core fields already speak for themselves via labelSchema.js and
// would just be noise here). `example` never reaches this function at all —
// composer.js only ever reads catalogs through readCatalogStripped.
export function buildRegulatoryBlock(rules, composedFields = null) {
  const ruleLines = !rules || rules.length === 0
    ? ["NO_AUTHORITATIVE_REQUIREMENTS — no approved regulatory rules exist yet for this country/product scope. Do not invent one; leave the corresponding fields for the validator to mark UNVERIFIABLE."]
    : rules.map((r) => `- [${r.severity}] ${r.ruleKey} (${r.ruleType}${r.targetPath ? `, targetPath: ${r.targetPath}` : ""}): ${r.description}\n  Citation: "${r.citation}"`);

  const catalogFields = (composedFields || []).filter((f) => f.contributedBy.length > 0);
  const catalogLines = catalogFields.map((f) => {
    const langs = f.requiredLanguages.length > 0 ? `, languages: ${f.requiredLanguages.join(",")}` : "";
    const when = f.appliesWhen.length > 0 ? `, applies when: ${f.appliesWhen.join(" OR ")}` : "";
    const formats = f.formatSpec.length > 0 ? `, format: ${f.formatSpec.map((s) => s.value).join(" | ")}` : "";
    return `- [${f.requirement}] "${f.key}"${langs}${when}${formats}`;
  });

  const sections = [`<REGULATORY_RULES>\n${ruleLines.join("\n")}\n</REGULATORY_RULES>`];
  if (catalogLines.length > 0) {
    sections.push(`<CATALOG_FIELD_REQUIREMENTS>\n(from ingested regulatory documents — requirement/language/format only, never a value)\n${catalogLines.join("\n")}\n</CATALOG_FIELD_REQUIREMENTS>`);
  }
  return sections.join("\n\n");
}

// schema: the Gemini JSON schema to describe (composed when composedFields
// was supplied to buildContext, else the static labelSchema-derived one) —
// the enforced constraint is always responseJsonSchema on the actual API
// call; this block only names it for the model's own reasoning.
export function buildSchemaBlock(schema = geminiResponseSchema) {
  return `<OUTPUT_SCHEMA>\nEnforced structurally via responseJsonSchema — this block exists only to name the constraint for the model's own reasoning, not to redefine it in prose.\nSchema: ${JSON.stringify(schema).slice(0, 200)}... (full schema enforced by the API call, not repeated here to save tokens)\n</OUTPUT_SCHEMA>`;
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
export function buildContext({ rules, rankedReferences, profile, composedFields = null }) {
  const schema = composedFields ? toGeminiSchema(composedFields) : geminiResponseSchema;
  const stablePrefix = [buildRegulatoryBlock(rules, composedFields), buildSchemaBlock(schema), buildReferenceBlock(rankedReferences)].join("\n\n");
  const variableSuffix = buildProductDataBlock(profile);
  return { prompt: `${stablePrefix}\n\n${variableSuffix}`, stablePrefix, variableSuffix, schema };
}
