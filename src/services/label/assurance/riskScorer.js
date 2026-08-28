// §14.6's exact formula. One risk score decides review depth — a design that
// assumes a reviewer checks everything equally is a design that gets ignored.
const FOOD_PRODUCING = new Set(["cattle", "cow", "cows", "buffalo", "sheep", "goat", "camel", "poultry", "chicken", "turkey", "duck", "pig", "swine", "rabbit", "fish"]);
const ANTIMICROBIAL_KEYWORDS = ["amoxicillin", "penicillin", "tetracycline", "oxytetracycline", "doxycycline", "sulfonamide", "sulfa", "enrofloxacin", "ciprofloxacin", "florfenicol", "tylosin", "erythromycin", "gentamicin", "colistin", "amoxi"];
export const HIGH_RISK_FIELDS = ["withdrawalPeriod", "strength", "activeIngredients", "registrationNumber"];

const isFoodProducing = (species) => [...FOOD_PRODUCING].some((s) => (species || "").toLowerCase().includes(s));
const isAntimicrobial = (ingredients) => (ingredients || []).some((i) => ANTIMICROBIAL_KEYWORDS.some((k) => (i.normalizedName || i.primary || "").toLowerCase().includes(k)));
const hasExternalProvenance = (labelProvenance, fields) => fields.some((f) => labelProvenance?.[f]?.provenance === "inferred" && labelProvenance?.[f]?.tier >= 5);

export function riskScore(labelData, report, { document, disagreementCount = 0, labelProvenance = {} } = {}) {
  let r = 0;
  if ((labelData.targetAnimalSpecies?.list || []).some(isFoodProducing)) r += 30;
  if (isAntimicrobial(labelData.activeIngredients)) r += 25;
  if (labelData.productType === "veterinary_drug") r += 15;
  if ((report?.verdicts || []).some((v) => v.status === "UNVERIFIABLE")) r += 20;
  r += 10 * (labelData.estimatedFields?.length || 0);
  if (hasExternalProvenance(labelProvenance, HIGH_RISK_FIELDS)) r += 25;
  if ((document?.coveragePercent ?? 100) < 95) r += 15;
  if (disagreementCount > 0) r += 20;
  return Math.min(r, 100);
}

/**
 * §14.6's four-bracket table, descending by risk. A design that assumes a
 * reviewer checks everything is a design that gets ignored — so lower-risk
 * labels get a lighter review, not none.
 */
export function autonomyTierFor(score) {
  if (score <= 20) return { tier: "auto_approve", review: "logged, 5% sample" };
  if (score <= 50) return { tier: "batch_review", review: "batched, 10 at a time" };
  if (score <= 75) return { tier: "mandatory_review", review: "field by field, named signature" };
  return { tier: "dual_review", review: "two independent reviewers" };
}
