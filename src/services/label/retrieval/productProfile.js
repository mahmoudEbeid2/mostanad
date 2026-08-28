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
    provenance.fromProductRow.push("indications");
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
