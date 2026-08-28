// §8.4's weighted scoring. Pure functions — testable without any real reference
// data (see tests/label.retrieval.test.js). NOT yet exercised against real
// reference_labels rows: this environment has 0 (see PROGRESS.md's Phase 4
// entry and §16's own note — under 30 references, this layer is unproven by
// necessity, not skipped by choice. It's built now because it's cheap, correct,
// pure code that reference-volume doesn't change the correctness of).

const jaccard = (a, b) => {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
};

const normalizeName = (s) => (s || "").toString().toLowerCase().trim().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

export function ingredientMatch(profileIngredients, refIngredients) {
  const a = profileIngredients.map((i) => normalizeName(i.normalizedName)).filter(Boolean);
  const b = refIngredients.map((i) => normalizeName(i.normalizedName || i.name)).filter(Boolean);
  if (a.length === 0 || b.length === 0) return 0;
  const overlap = jaccard(a, b);
  // Exact set match (same ingredients, nothing more/less on either side) gets
  // full credit; a partial overlap is scored proportionally, never rounded up.
  return overlap;
}

function extractNumber(text) {
  const m = (text || "").toString().match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

export function strengthProximity(profileStrength, refStrength) {
  const a = extractNumber(profileStrength);
  const b = extractNumber(refStrength);
  if (a === null || b === null || a <= 0 || b <= 0) return 0;
  const diff = Math.abs(Math.log(a / b));
  return Math.max(0, 1 - diff); // identical -> 1.0, decays as the log-ratio grows
}

export function dosageFormMatch(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  const FAMILIES = [["powder", "granule"], ["liquid", "solution", "suspension"], ["tablet", "bolus"]];
  const familyOf = (v) => FAMILIES.findIndex((f) => f.some((m) => v.includes(m)));
  const fa = familyOf(na), fb = familyOf(nb);
  return fa !== -1 && fa === fb ? 0.6 : 0;
}

export function speciesOverlap(a, b) {
  return jaccard((a || []).map(normalizeName), (b || []).map(normalizeName));
}

export function scoreReference(profile, reference) {
  const iMatch = ingredientMatch(profile.activeIngredients || [], reference.activeIngredients || []);
  const sProx = strengthProximity(profile.strength, reference.strengthSummary);
  const dMatch = dosageFormMatch(profile.dosageForm, reference.dosageForm);
  const spOverlap = speciesOverlap(profile.targetSpecies || [], reference.targetSpecies || []);
  const iOverlap = jaccard(profile.indicationTags || [], reference.indicationTags || []);
  const rMatch = normalizeName(profile.routeOfAdministration) === normalizeName(reference.routeOfAdministration) && !!profile.routeOfAdministration ? 1 : 0;
  const cMatch = normalizeName(profile.country) === normalizeName(reference.country) && !!profile.country ? 1 : 0;

  const score =
    0.4 * iMatch +
    0.15 * sProx +
    0.12 * dMatch +
    0.12 * spOverlap +
    0.1 * iOverlap +
    0.07 * rMatch +
    0.04 * cMatch;

  const qualityWeight = reference.qualityWeight ?? 0.7;
  return { score, finalScore: score * qualityWeight, breakdown: { iMatch, sProx, dMatch, spOverlap, iOverlap, rMatch, cMatch } };
}

/**
 * §8.4's tier table. The tier is computed here, in code — the model never
 * decides how much to trust a reference (Invariant #2).
 */
export function tierFor({ score, breakdown }, { hasCountryOnlyMatch = false } = {}) {
  if (breakdown.iMatch === 1.0 && breakdown.sProx >= 0.9) return "exact_combo";
  if (breakdown.iMatch >= 0.5) return "ingredient";
  if (score >= 0.45) return "attribute";
  if (hasCountryOnlyMatch) return "style_only";
  return "none";
}

export function rankReferences(profile, references) {
  return references
    .map((reference) => {
      const scored = scoreReference(profile, reference);
      return { reference, ...scored, tier: tierFor(scored, { hasCountryOnlyMatch: normalizeName(profile.country) === normalizeName(reference.country) }) };
    })
    .filter((r) => r.tier !== "none")
    .sort((a, b) => b.finalScore - a.finalScore);
}
