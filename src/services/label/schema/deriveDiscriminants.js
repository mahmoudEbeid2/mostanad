// Task 4 — "derive the discriminants from product data where they can be
// derived." The MECHANISM here is generic text matching against a
// ProductProfile's own fields (productType, dosageForm, routeOfAdministration,
// targetSpecies, indicationTags) — it never hardcodes a discriminant's NAME or
// an authority's vocabulary; that would put content back in code. It's a
// best-effort heuristic, not a guarantee: a discriminant whose document
// wording doesn't textually resemble anything on the profile is reported
// unresolved, not guessed at, because a wrong discriminant value would filter
// the composed schema wrong in a way nobody would notice until a required
// field silently never appeared.
const normalize = (s) => (s || "").toString().trim().toLowerCase();

function candidateProfileStrings(profile) {
  const strings = [];
  if (profile.productType) strings.push(profile.productType);
  if (profile.dosageForm) strings.push(profile.dosageForm);
  if (profile.routeOfAdministration) strings.push(profile.routeOfAdministration);
  for (const s of profile.targetSpecies || []) strings.push(s);
  for (const tag of profile.indicationTags || []) strings.push(tag);
  return [...new Set(strings.map(normalize).filter(Boolean))];
}

/**
 * knownDiscriminants: composer.getKnownDiscriminants(...)'s output.
 * Returns { resolved: {key: valueKey}, unresolved: [{key, labelInDocument, values}] }.
 * `unresolved` is what the frontend needs to ask the user for directly.
 */
export function deriveDiscriminants(profile, knownDiscriminants = []) {
  const resolved = {};
  const unresolved = [];
  const profileStrings = candidateProfileStrings(profile);

  for (const d of knownDiscriminants) {
    let matchedValueKey = null;
    for (const value of d.values || []) {
      const valueLabel = normalize(value.labelInDocument);
      const valueKey = normalize(value.key);
      const isMatch = profileStrings.some(
        (s) => s === valueLabel || s === valueKey || (valueLabel.length > 2 && (s.includes(valueLabel) || valueLabel.includes(s)))
      );
      if (isMatch) { matchedValueKey = value.key; break; }
    }
    if (matchedValueKey) resolved[d.key] = matchedValueKey;
    else unresolved.push({ key: d.key, labelInDocument: d.labelInDocument, values: (d.values || []).map((v) => v.key) });
  }

  return { resolved, unresolved };
}
