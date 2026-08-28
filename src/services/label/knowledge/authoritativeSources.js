// §8.2's allowlist for PRODUCT knowledge lookups (Tier 5) — distinct from
// officialSources.js's regulatory-authority allowlist (Phase 3). A grounded
// claim whose host isn't here is discarded outright, not downgraded.
export const PRODUCT_KNOWLEDGE_SOURCES = [
  { id: "ema_vet", domains: ["ema.europa.eu"], weight: "high" },
  { id: "fda_anada", domains: ["animaldrugsatfda.fda.gov", "fda.gov"], weight: "high" },
  { id: "eda", domains: ["edaegypt.gov.eg"], weight: "high" },
  { id: "sfda", domains: ["sfda.gov.sa"], weight: "high" },
  { id: "vich", domains: ["vichsec.org"], weight: "high" },
  { id: "who_woah", domains: ["who.int", "woah.org"], weight: "medium" },
  { id: "pharmacop", domains: ["usp.org", "pheur.edqm.eu"], weight: "medium" },
];

export function isAllowedKnowledgeHost(url) {
  try {
    const host = new URL(url).hostname;
    return PRODUCT_KNOWLEDGE_SOURCES.some((s) => s.domains.some((d) => host === d || host.endsWith("." + d)));
  } catch {
    return false;
  }
}
