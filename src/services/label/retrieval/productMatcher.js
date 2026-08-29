import { prisma } from "../../../lib/prisma.js";
import { rankReferences } from "./similarity.js";

// §14.5.1's "which product is this label for" step. Reuses the exact weighted
// scoring generation retrieval already uses (rankReferences/scoreReference,
// §8.4) instead of a second, cruder scoring implementation — that's how a
// 2-active oral liquid used to match a 30-active powder: the old query
// returned the most recently created product sharing ANY single ingredient,
// unscoped by tenant. This module never queries outside `companyId`.

function mapProductToScorable(product) {
  return {
    id: product.id,
    name: product.name,
    country: null, // Product has no country column today
    activeIngredients: (Array.isArray(product.activeIngredients) ? product.activeIngredients : []).map((i) => ({
      normalizedName: (typeof i === "string" ? i : i?.name || "").toLowerCase(),
    })),
    targetSpecies: Array.isArray(product.targetSpecies) ? product.targetSpecies : [],
    dosageForm: product.dosageForm || product.physicalForm || null,
    strengthSummary: product.strength || null,
    routeOfAdministration: product.routeOfAdmin || null,
    indicationTags: product.indications ? [product.indications] : [],
    qualityWeight: 1, // a confirmed Product row, not a community reference — no discount
  };
}

function mapExtractedToProfile(extracted, country) {
  const ingredients = Array.isArray(extracted.activeIngredients) ? extracted.activeIngredients : [];
  return {
    activeIngredients: ingredients.map((i) => ({ normalizedName: (i.name || "").toLowerCase() })),
    strength: extracted.strength || null,
    dosageForm: extracted.pharmaceuticalForm || null,
    targetSpecies: Array.isArray(extracted.targetAnimalSpeciesList) ? extracted.targetAnimalSpeciesList : [],
    routeOfAdministration: extracted.routeOfAdministration || null,
    indicationTags: extracted.aimOfUse ? [extracted.aimOfUse] : [],
    country: country || null,
  };
}

const noMatch = () => ({ dbProduct: null, existsInDb: false, isExactMatch: false, matchState: "none", matchTier: "none", matchScore: 0 });

/**
 * Tenant-scoped, weighted-similarity product match for an extracted label.
 * Three states, deliberately no middle ground that lets a "close enough"
 * candidate stand in for "the same product":
 *
 *   "matched" — an exact product-name match, or an ingredients+strength combo
 *               match (similarity.js's "exact_combo" tier). Safe to treat as
 *               the same product: data_mismatch verdicts are meaningful.
 *   "similar" — a closest candidate scored above the "none" tier, but a
 *               DIFFERENT product. Caller must emit ZERO data_mismatch
 *               verdicts against it and surface it only as information, never
 *               silently substitute it for the real product.
 *   "none"    — nothing scored, or no products exist for this tenant. Check
 *               regulations/coherence only.
 */
export async function matchProduct(extracted, country, companyId) {
  if (!companyId) return noMatch();

  const products = await prisma.product.findMany({
    where: { companyId },
    include: { category: true, brand: true },
  });
  if (products.length === 0) return noMatch();

  const extractedName = (extracted.productName || "").trim();
  if (extractedName) {
    const exact = products.find((p) => p.name.toLowerCase() === extractedName.toLowerCase());
    if (exact) {
      return { dbProduct: exact, existsInDb: true, isExactMatch: true, matchState: "matched", matchTier: "name_exact", matchScore: 1 };
    }
  }

  const profile = mapExtractedToProfile(extracted, country);
  const ranked = rankReferences(profile, products.map(mapProductToScorable));
  if (ranked.length === 0) return noMatch();

  const top = ranked[0];
  const dbProduct = products.find((p) => p.id === top.reference.id);
  const matchState = top.tier === "exact_combo" ? "matched" : "similar";

  return { dbProduct, existsInDb: true, isExactMatch: false, matchState, matchTier: top.tier, matchScore: top.finalScore };
}
