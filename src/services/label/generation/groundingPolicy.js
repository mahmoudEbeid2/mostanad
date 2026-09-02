// CLAUDE.md invariant #5 / §8.2's absolute exclusions. These fields may NEVER
// be filled from model knowledge or unconfirmed external lookup — Tier 1
// (Product row), Tier 2 (user hint), or Tier 4 (a matched reference) only.
// Empty + FAIL beats a plausible-looking guess: a wrong withdrawal period or
// strength is a direct human/animal safety risk, and a fabricated registration
// number is forging an official document.
//
// shelfLifeAfterOpening is here for a different reason than the other five:
// it isn't a regulatory-lookup fact at all, it's the result of a stability
// study run by the manufacturer on THIS product. No reference label, no
// EMA/FDA/EDA/SFDA/VICH/WHO/USP document, and no amount of model knowledge can
// supply it — there is nothing external to cite. Tier 4 and Tier 5 are both
// structurally the wrong kind of source for this field, not just an unproven
// one, so it is excluded the same as the others rather than routed through
// them and hoping the search comes up empty.
export const NEVER_GUESS_FIELDS = [
  "withdrawalPeriod",
  "strength",
  "activeIngredients[].amount",
  "registrationNumber",
  "batchNo",
  "expiryDate",
  "shelfLifeAfterOpening",
];

// Shown to the user in place of a value when a NEVER_GUESS field is empty —
// the UI needs to distinguish "we couldn't find it" from "this can never be
// estimated, go get it yourself" instead of leaving it looking like an
// oversight. Fields not listed here fall back to a generic refusal message.
const REFUSAL_REASONS = {
  shelfLifeAfterOpening: "Not estimated — this comes from your own stability data.",
};

const DEFAULT_REFUSAL_REASON = (field) => `Not estimated — "${field}" may only come from a confirmed source or a matched reference, never a guess.`;

export const isNeverGuessField = (fieldPath) => NEVER_GUESS_FIELDS.includes(fieldPath);

export const refusalReasonFor = (fieldPath) => REFUSAL_REASONS[fieldPath] || DEFAULT_REFUSAL_REASON(fieldPath);

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
