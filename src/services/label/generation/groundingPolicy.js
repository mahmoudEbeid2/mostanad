// CLAUDE.md invariant #5 (amended — "every field is generated" policy). These
// fields used to be hard-refused (empty + FAIL) when no confirmed source or
// matched reference existed. That is no longer the behavior: they now run the
// SAME Tier 1-6 ladder as every other field, Tier 6 (model inference) included
// — but they stay in this list because they get the strictest downstream
// treatment for it: a Tier 6 value on one of these is always tagged
// `estimated: true` with `estimateBasis`, a targeted regulatory rule downgrades
// an otherwise-PASS verdict to NEEDS_REVIEW (validationEngine.js), and
// approval must explicitly list it in signedEstimatedFields. A wrong
// withdrawal period or strength is a direct human/animal safety risk, and a
// fabricated registration number reads as an official document — the
// mitigation is now "flagged and reviewed", not "refused".
//
// shelfLifeAfterOpening is here for a different reason than the other six: it
// isn't a regulatory-lookup fact at all, it's the result of a stability study
// run by the manufacturer on THIS product — no reference label or
// EMA/FDA/EDA/SFDA/VICH/WHO/USP document can supply it. Tier 4/5 will almost
// always miss for this field specifically; Tier 6 is expected to carry it more
// often than the others.
export const NEVER_GUESS_FIELDS = [
  "withdrawalPeriod",
  "strength",
  "activeIngredients[].amount",
  "registrationNumber",
  "batchNo",
  "expiryDate",
  "shelfLifeAfterOpening",
];

// One-line "what it was inferred from" text for labelProvenance[path].estimateBasis
// when a NEVER_GUESS_FIELDS field lands on Tier 6 (no confirmed source, matched
// reference, or cited external lookup found it). Shown to a human reviewer/signer,
// not baked into labelData itself — provenance carries it (§ policy decision:
// "provenance-only", labelData fields keep their plain natural type).
const DEFAULT_ESTIMATE_BASIS = (field) => `No confirmed source, matched reference, or cited external lookup for "${field}" — model's best inference from the product's active ingredient(s), dosage form, and product type. Requires human review before approval.`;
const ESTIMATE_BASIS_OVERRIDES = {
  shelfLifeAfterOpening: "No manufacturer stability data available — model's best inference from dosage form and packaging. Requires human review before approval.",
};

export const isNeverGuessField = (fieldPath) => NEVER_GUESS_FIELDS.includes(fieldPath);

export const estimateBasisFor = (fieldPath) => ESTIMATE_BASIS_OVERRIDES[fieldPath] || DEFAULT_ESTIMATE_BASIS(fieldPath);

// §8.2's field-by-field ladder (Tier 1 confirmed -> Tier 2 hint -> Tier 4
// matched reference -> Tier 5 cited external lookup -> Tier 6 null/UNVERIFIABLE)
// applies to these. They are content fields with a real regulatory/factual
// source that can back them (a reference label, or an allowlisted
// EMA/FDA/EDA/SFDA/VICH/WHO/USP document) — unlike the NEVER_GUESS set, an
// external citation IS an acceptable source for these, just never bare model
// knowledge with no citation.
export const GROUNDED_CONTENT_FIELDS = [
  "sideEffects",
  "indications",
  "targetAnimalSpecies",
  "directionOfUse",
  "storage",
  "contraindications",
  "warnings",
  "feedClassification",
  "routeOfAdministration",
];
