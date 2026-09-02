import { prisma } from "../../../lib/prisma.js";

// §8.1 — the unified generation input. If productId is given, the Product row
// is read and its fields are Tier 1 ("confirmed") — this is the fix for G2:
// the generator used to take formulationText + hints only and NEVER read the
// Product row at all, so a product's own targetSpecies/activeIngredients never
// reached generation. Free text is a supplement, never a replacement, for a
// confirmed field.
export const buildProductProfile = async ({ productId, formulationText, country, language, hints = {} }) => {
  const provenance = { fromProductRow: [], fromFreeText: !!formulationText, fromUserHints: [] };
  const confirmedFacts = {};

  let product = null;
  if (productId) {
    product = await prisma.product.findUnique({ where: { id: productId } });
  }

  const activeIngredients = [];
  if (product?.activeIngredients && Array.isArray(product.activeIngredients)) {
    for (const ing of product.activeIngredients) {
      activeIngredients.push({
        normalizedName: (ing.name || "").toLowerCase().trim() || null,
        amount: ing.concentration || ing.amount || null,
        unit: null,
        strengthMgPerUnit: null,
      });
    }
    if (activeIngredients.length > 0) provenance.fromProductRow.push("activeIngredients");
  }

  const targetSpecies = product?.targetSpecies?.length > 0 ? product.targetSpecies : [];
  if (targetSpecies.length > 0) {
    provenance.fromProductRow.push("targetSpecies");
    confirmedFacts.targetSpecies = targetSpecies;
  }

  if (product?.indications?.trim()) {
    confirmedFacts.aimOfUse = product.indications.trim();
    confirmedFacts.indications = product.indications.trim();
    provenance.fromProductRow.push("indications");
  }

  // Bug fix: these three used to only get pushed onto provenance.fromProductRow
  // (bookkeeping) without ever landing in confirmedFacts (the actual data the
  // ladder reads) — so a Product row's own storage/contraindications/dosage
  // text never reached generation as a Tier 1 fact, silently falling through
  // to Tier 4/5/estimate even when the confirmed value was sitting right there.
  if (product?.storage?.trim()) {
    confirmedFacts.storage = product.storage.trim();
    provenance.fromProductRow.push("storage");
  }
  if (product?.contraindications?.trim()) {
    confirmedFacts.contraindications = product.contraindications.trim();
    provenance.fromProductRow.push("contraindications");
  }
  if (product?.mixingInstructions?.trim() || product?.dosage?.trim()) {
    confirmedFacts.directionOfUse = (product.mixingInstructions || product.dosage).trim();
    provenance.fromProductRow.push("directionOfUse");
  }
  if (Array.isArray(product?.userSafety) && product.userSafety.length > 0) {
    confirmedFacts.warnings = product.userSafety.filter(Boolean);
    provenance.fromProductRow.push("userSafety");
  }

  if (hints.aimOfUseHint?.trim()) {
    confirmedFacts.aimOfUse = hints.aimOfUseHint.trim();
    provenance.fromUserHints.push("aimOfUse");
  }
  if (hints.targetSpeciesHint?.trim()) {
    confirmedFacts.targetSpecies = hints.targetSpeciesHint.trim().split(/[,،]/).map((s) => s.trim()).filter(Boolean);
    provenance.fromUserHints.push("targetSpecies");
  }
  if (hints.directionOfUseHint?.trim()) {
    confirmedFacts.directionOfUse = hints.directionOfUseHint.trim();
    provenance.fromUserHints.push("directionOfUse");
  }

  for (const field of ["routeOfAdmin", "dosageForm", "strength", "productType", "prescriptionStatus", "withdrawalPeriod", "registrationNumber", "storage", "packaging"]) {
    if (product?.[field]) provenance.fromProductRow.push(field);
  }

  return {
    productId: productId || null,
    productType: product?.productType || null,
    activeIngredients,
    dosageForm: product?.dosageForm || product?.physicalForm || null,
    routeOfAdministration: product?.routeOfAdmin || null,
    strength: product?.strength || null,
    targetSpecies,
    indicationTags: product?.indications ? [product.indications] : [],
    country,
    language,
    netWeight: null,
    packaging: product?.packaging || null,
    withdrawalPeriod: product?.withdrawalPeriod || null,
    registrationNumber: product?.registrationNumber || null,
    prescriptionStatus: product?.prescriptionStatus || null,
    formulationText: formulationText || null,
    confirmedFacts,
    provenance,
  };
};
