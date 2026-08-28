import { prisma } from "../../../lib/prisma.js";
import { rankReferences } from "./similarity.js";

// §8.3's query, adapted to the columns that actually exist today. §5.9 would
// add isApproved/productType/activeIngredients/targetSpecies/qualityWeight as
// real columns on ReferenceLabel — that migration was never built (flagged as
// a deviation back in Phase 0's tenant-scoping fix), so this reads the same
// extracted_data JSON shape referenceLabelWorker.js has always produced
// (active_ingredients[], target_animal_species[]) instead. Tenant scoping
// (companyId OR null) is the one part of §8.3 that's fully real regardless.
function mapToScorable(ref) {
  const data = ref.extractedData || {};
  return {
    id: ref.id,
    name: ref.name,
    country: ref.country,
    activeIngredients: (Array.isArray(data.active_ingredients) ? data.active_ingredients : []).map((i) => ({
      normalizedName: (typeof i === "string" ? i : i?.name || "").toLowerCase(),
    })),
    targetSpecies: Array.isArray(data.target_animal_species) ? data.target_animal_species : [],
    dosageForm: null, // no dedicated column yet — see file header
    strengthSummary: null,
    routeOfAdministration: null,
    indicationTags: [],
    qualityWeight: 0.7, // §5.9's default — no promotion/carousel data exists yet (Phase 7-8)
  };
}

/**
 * Returns ranked, tenant-scoped reference candidates with a code-computed tier
 * (Invariant #2 — the model never decides how much to trust a reference).
 */
export const selectReferences = async (profile, { take = 200, topK = 3 } = {}) => {
  const candidates = await prisma.referenceLabel.findMany({
    where: { OR: [{ companyId: profile.companyId ?? null }, { companyId: null }] },
    orderBy: { createdAt: "desc" },
    take,
  });

  const ranked = rankReferences(profile, candidates.map(mapToScorable));
  const top = ranked.slice(0, topK);

  // Re-attach the full original reference row (extractedData/fullText) for
  // whoever builds the prompt context — mapToScorable only kept what scoring needed.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return top.map((r) => ({ ...r, reference: byId.get(r.reference.id) }));
};
