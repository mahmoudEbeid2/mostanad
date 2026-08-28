// Layer 4 (§10.1) — deterministic cross-field consistency, independent of any
// external rule source. Six checks named explicitly in §10.1:
//   1. analysis vs. activeIngredients amounts (same substance, consistent numbers)
//   2. every LocalizedText's `primary` key actually exists in its `translations`
//   3. no bare "x" placeholder anywhere in the label
//   4. targetAnimalSpecies.list has no duplicate entries
//   5. ingredient units vs. pharmaceutical form (liquid label, powder units = contradiction)
//   6. ingredient totals not mathematically impossible (>100% or >1000 g/kg)
//
// 5 and 6 moved here from the plausibility layer (§14.5.7) — the dividing
// line is not "deterministic vs AI", it's "does judging this need anything
// from outside the label". Both are self-contained: everything needed to call
// them is already on the label. That's why, unlike plausibility (which can
// only ever emit WARN/NEEDS_REVIEW), this layer can emit FAIL.

const extractNumber = (text) => {
  const match = (text || "").toString().match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
};

const verdict = (path, status, message, extra = {}) => ({
  path,
  label: { en: path, ar: path },
  status,
  presence: status === "FAIL" ? "INVALID" : "PRESENT",
  severity: status === "FAIL" ? "error" : status === "WARN" ? "warning" : "error",
  layer: "coherence",
  ruleKey: `COHERENCE.${path.toUpperCase()}`,
  message,
  citation: null,
  sourceDocumentId: null,
  autoFixable: false,
  suggestion: null,
  ...extra,
});

function checkAnalysisVsAmounts(labelData) {
  if (!labelData.analysis?.items?.length || !labelData.activeIngredients?.length) {
    return verdict("analysis", "NOT_APPLICABLE", null);
  }
  const mismatches = [];
  for (const ingredient of labelData.activeIngredients) {
    const name = (ingredient.normalizedName || ingredient.primary || "").toLowerCase();
    if (!name) continue;
    const matchingItem = labelData.analysis.items.find((item) => (item.name || "").toLowerCase().includes(name) || name.includes((item.name || "").toLowerCase()));
    if (!matchingItem) continue;
    const ingredientNum = extractNumber(ingredient.amount);
    const analysisNum = extractNumber(matchingItem.value);
    if (ingredientNum !== null && analysisNum !== null && ingredientNum !== analysisNum) {
      mismatches.push(`${name}: ingredient amount "${ingredient.amount}" vs analysis "${matchingItem.value}"`);
    }
  }
  return mismatches.length
    ? verdict("analysis", "WARN", `Analysis values inconsistent with ingredient amounts: ${mismatches.join("; ")}`)
    : verdict("analysis", "PASS", null);
}

function findLocalizedTextEntries(value, path = "") {
  const found = [];
  if (value && typeof value === "object") {
    if ("translations" in value && "primary" in value) {
      found.push({ path, value });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => found.push(...findLocalizedTextEntries(item, `${path}[${i}]`)));
    } else {
      Object.entries(value).forEach(([key, v]) => found.push(...findLocalizedTextEntries(v, path ? `${path}.${key}` : key)));
    }
  }
  return found;
}

function checkPrimaryInTranslations(labelData) {
  const entries = findLocalizedTextEntries(labelData);
  const bad = entries.filter(({ value }) => value.primary && !(value.primary in (value.translations || {})));
  return bad.length
    ? verdict("_localized_text", "FAIL", `Fields whose "primary" language is missing from "translations": ${bad.map((b) => b.path).join(", ")}`)
    : verdict("_localized_text", "PASS", null);
}

function checkNoPlaceholderX(labelData) {
  const offenders = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (value.trim().toLowerCase() === "x") offenders.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      Object.entries(value).forEach(([k, v]) => walk(v, path ? `${path}.${k}` : k));
    }
  };
  walk(labelData, "");
  return offenders.length
    ? verdict("_placeholder_x", "FAIL", `Bare "x" placeholder found at: ${offenders.join(", ")}`)
    : verdict("_placeholder_x", "PASS", null);
}

function checkNoDuplicateSpecies(labelData) {
  const list = labelData.targetAnimalSpecies?.list || [];
  const seen = new Set();
  const dupes = [];
  for (const species of list) {
    const key = species.toLowerCase().trim();
    if (seen.has(key)) dupes.push(species);
    seen.add(key);
  }
  return dupes.length
    ? verdict("targetAnimalSpecies.list", "WARN", `Duplicate species entries: ${dupes.join(", ")}`)
    : verdict("targetAnimalSpecies.list", "PASS", null);
}

// §10.1 check 5: liquid forms take mg/ml, %w/v, IU/ml; solid forms take
// mg/g, g/kg, %w/w, IU/g. `analysis.basis` ("per 1 L" | "per 1 kg") is the
// more reliable signal when present; pharmaceuticalForm's free text is the
// fallback. A form we can't classify means this check can't run — that's
// NOT_APPLICABLE, not a pass, since "unknown" isn't "consistent".
const LIQUID_FORM_KEYWORDS = /liquid|solution|suspension|syrup|injectable|drops|drench/i;
const SOLID_FORM_KEYWORDS = /powder|premix|tablet|granule|feed|bolus|capsule|paste/i;

function classifyFormCategory(labelData) {
  if (labelData.analysis?.basis === "per 1 L") return "liquid";
  if (labelData.analysis?.basis === "per 1 kg") return "solid";
  const texts = Object.values(labelData.pharmaceuticalForm?.translations || {}).join(" ");
  if (LIQUID_FORM_KEYWORDS.test(texts)) return "liquid";
  if (SOLID_FORM_KEYWORDS.test(texts)) return "solid";
  return null;
}

function classifyIngredientUnitPhase(rawUnit) {
  if (!rawUnit) return null;
  const u = rawUnit.replace(/\s+/g, "").toLowerCase();
  if (/^(mg|mcg|ug|iu)\/ml$/.test(u) || u === "%w/v") return "liquid";
  if (/^(mg|mcg|ug|iu)\/(g|kg)$/.test(u) || u === "%w/w" || u === "g/kg") return "solid";
  return null;
}

function checkUnitsMatchForm(labelData) {
  const formCategory = classifyFormCategory(labelData);
  if (!formCategory) return verdict("pharmaceuticalForm", "NOT_APPLICABLE", null);

  const contradictions = [];
  for (const ing of labelData.activeIngredients || []) {
    const unitPhase = classifyIngredientUnitPhase(ing.unit);
    if (!unitPhase || unitPhase === formCategory) continue;
    contradictions.push(`${ing.normalizedName || ing.primary}: unit "${ing.unit}" is a ${unitPhase} unit but the labeled form is ${formCategory}`);
  }

  return contradictions.length
    ? verdict("pharmaceuticalForm", "FAIL", `Ingredient units contradict the stated pharmaceutical form: ${contradictions.join("; ")}`)
    : verdict("pharmaceuticalForm", "PASS", null);
}

// §10.1 check 6: only percent-family and mass-per-kg-family units are summed
// (mg/ml etc. are concentrations, not mass fractions — there's no universal
// ceiling to check them against without knowing volume/density, so those are
// left to plausibility's §14.5.7 sourced checks, not this one). Ingredients
// with an unparseable/unlisted unit are excluded from the sum rather than
// blocking the check — the parseable subset already exceeding the ceiling is
// still a mathematical impossibility regardless of what else is on the label.
const extractIngredientNumber = extractNumber;

function classifyIngredientMassUnit(rawUnit) {
  if (!rawUnit) return null;
  const u = rawUnit.replace(/\s+/g, "").toLowerCase();
  if (u === "%" || u === "%w/w" || u === "%w/v") return { family: "percent", toBase: (n) => n };
  if (u === "g/kg" || u === "mg/g") return { family: "mass_per_kg", toBase: (n) => n }; // 1 mg/g == 1 g/kg numerically
  if (u === "mg/kg") return { family: "mass_per_kg", toBase: (n) => n / 1000 };
  return null;
}

function checkIngredientTotalNotImpossible(labelData) {
  const byFamily = { percent: [], mass_per_kg: [] };
  for (const ing of labelData.activeIngredients || []) {
    if ((ing.amount || "").trim().toLowerCase() === "q.s.") continue;
    const classified = classifyIngredientMassUnit(ing.unit);
    if (!classified) continue;
    const num = extractIngredientNumber(ing.amount);
    if (num === null) continue;
    byFamily[classified.family].push({ name: ing.normalizedName || ing.primary, value: classified.toBase(num) });
  }

  const failures = [];
  const percentTotal = byFamily.percent.reduce((sum, i) => sum + i.value, 0);
  if (byFamily.percent.length && percentTotal > 100) {
    failures.push(`ingredient percentages sum to ${percentTotal.toFixed(2)}% (> 100%): ${byFamily.percent.map((i) => `${i.name} ${i.value}%`).join(", ")}`);
  }
  const massTotal = byFamily.mass_per_kg.reduce((sum, i) => sum + i.value, 0);
  if (byFamily.mass_per_kg.length && massTotal > 1000) {
    failures.push(`ingredient amounts sum to ${massTotal.toFixed(2)} g/kg (> 1000 g/kg, more mass than the product itself): ${byFamily.mass_per_kg.map((i) => `${i.name} ${i.value}g/kg`).join(", ")}`);
  }

  return failures.length
    ? verdict("activeIngredients", "FAIL", `Mathematically impossible ingredient total — ${failures.join("; ")}`)
    : verdict("activeIngredients", "PASS", null);
}

export const run = (labelData) => [
  checkAnalysisVsAmounts(labelData),
  checkPrimaryInTranslations(labelData),
  checkNoPlaceholderX(labelData),
  checkNoDuplicateSpecies(labelData),
  checkUnitsMatchForm(labelData),
  checkIngredientTotalNotImpossible(labelData),
];
