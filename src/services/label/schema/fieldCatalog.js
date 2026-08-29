// Conditional applicability (§6.4) — resolved from the label's OWN content, not
// scattered `if` statements across the validation engine. A field not in this
// catalog is unconditionally applicable (no NOT_APPLICABLE branch for it).
//
// isFoodProducingSpecies / isMultiDose are heuristic species/packaging lists, not
// authoritative regulatory data. They exist so Phase 2 has a working conditional
// engine before Phase 3's RegulatoryRule conditional rules (§7.3's own example is
// exactly this: `anyOf: ["Cattle","Sheep","Goat","Camel","Poultry"]`) can be
// authored per country from real authority documents. Once those rules exist for
// a country, they take precedence for that country — this stays as the fallback
// for country/species combinations with no compiled rule yet.

const FOOD_PRODUCING_SPECIES = new Set([
  "cattle", "cow", "cows", "buffalo", "sheep", "goat", "camel",
  "poultry", "chicken", "chickens", "broiler", "broilers", "layer", "layers",
  "turkey", "turkeys", "duck", "ducks", "quail",
  "pig", "pigs", "swine", "rabbit", "rabbits", "fish", "aquaculture", "shrimp",
]);

export const isFoodProducingSpecies = (species) => {
  const normalized = (species || "").toString().trim().toLowerCase();
  if (!normalized) return false;
  return [...FOOD_PRODUCING_SPECIES].some((s) => normalized.includes(s));
};

const MULTI_DOSE_HINTS = ["bottle", "vial", "container", "bag", "drum", "jerrycan", "multi-dose", "multi dose"];
const SINGLE_DOSE_HINTS = ["sachet", "blister", "single-dose", "single dose", "ampoule", "ampule", "syringe"];

export const isMultiDose = (packaging) => {
  if (!packaging) return false;
  const values = [packaging.primary, ...Object.values(packaging.translations || {})]
    .filter(Boolean)
    .map((v) => v.toString().toLowerCase());
  if (values.some((v) => SINGLE_DOSE_HINTS.some((hint) => v.includes(hint)))) return false;
  return values.some((v) => MULTI_DOSE_HINTS.some((hint) => v.includes(hint)));
};

// describeTrigger(l): a plain-words statement of WHAT about this specific
// label satisfied appliesWhen — e.g. "this label lists poultry and calves,
// which are food-producing". Only called when appliesWhen(l) is true. Feeds
// FieldVerdict.triggeredBy so the user sees why a conditional rule fired on
// their label, not just that one did.
export const fieldCatalog = {
  withdrawalPeriod: {
    severity: "error",
    appliesWhen: (l) => (l.targetAnimalSpecies?.list || []).some(isFoodProducingSpecies),
    reason: "Withdrawal period is mandatory for food-producing species.",
    describeTrigger: (l) => {
      const matched = (l.targetAnimalSpecies?.list || []).filter(isFoodProducingSpecies);
      if (matched.length === 0) return null;
      return `this label lists ${matched.join(", ")}, which ${matched.length > 1 ? "are" : "is"} food-producing`;
    },
  },
  routeOfAdministration: {
    severity: "error",
    appliesWhen: (l) => l.productType === "veterinary_drug",
    reason: "Route of administration is mandatory for veterinary drugs.",
    describeTrigger: (l) => `this label's product type is "${l.productType}"`,
  },
  pharmaceuticalForm: {
    severity: "error",
    appliesWhen: (l) => l.productType === "veterinary_drug",
    reason: "Pharmaceutical form is mandatory for veterinary drugs.",
    describeTrigger: (l) => `this label's product type is "${l.productType}"`,
  },
  strength: {
    severity: "error",
    appliesWhen: (l) => l.productType === "veterinary_drug",
    reason: "Strength is mandatory for veterinary drugs.",
    describeTrigger: (l) => `this label's product type is "${l.productType}"`,
  },
  sideEffects: {
    severity: "warning",
    appliesWhen: (l) => l.productType === "veterinary_drug",
    reason: "Side effects should be stated for veterinary drugs.",
    describeTrigger: (l) => `this label's product type is "${l.productType}"`,
  },
  feedClassification: {
    severity: "error",
    appliesWhen: (l) => ["feed_additive", "premix", "supplement", "compound_feed"].includes(l.productType),
    reason: "Feed classification is mandatory for feed-type products.",
    describeTrigger: (l) => `this label's product type is "${l.productType}", a feed-type product`,
  },
  analysis: {
    severity: "warning",
    appliesWhen: (l) => ["feed_additive", "premix", "compound_feed"].includes(l.productType),
    reason: "A nutrient/analysis panel is expected for this product type.",
    describeTrigger: (l) => `this label's product type is "${l.productType}", a feed-type product`,
  },
  shelfLifeAfterOpening: {
    severity: "warning",
    appliesWhen: (l) => isMultiDose(l.packaging),
    reason: "Multi-dose packaging should state shelf life after opening.",
    describeTrigger: () => "this label's packaging reads as multi-dose (bottle/vial/container/bag/drum)",
  },
};

/**
 * Resolves whether a cataloged field applies to this label, and its severity if so.
 * Returns null for fields not in the catalog — caller treats those as unconditional.
 */
export const resolveApplicability = (path, labelData) => {
  const entry = fieldCatalog[path];
  if (!entry) return null;
  const applies = entry.appliesWhen(labelData);
  return {
    applies,
    severity: entry.severity,
    reason: entry.reason,
    triggeredBy: applies && entry.describeTrigger ? entry.describeTrigger(labelData) : null,
  };
};
