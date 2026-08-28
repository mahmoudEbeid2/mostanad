// Pure scoring logic for the golden set (§14.3), split out of evalGolden.js so
// it's unit-testable without the live pipeline (server/worker/Gemini quota).

export function flattenToText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenToText).join("; ");
  if (typeof value === "object") {
    if ("en" in value) return value.en || "";
    if ("basis" in value && "items" in value) {
      return `${value.basis}: ${(value.items || []).map((i) => `${i.name} ${i.value}`).join(", ")}`;
    }
    if ("name" in value && "value" in value) return `${value.name} ${value.value}`;
  }
  return JSON.stringify(value);
}

// Synonym groups are treated as fully interchangeable in both directions: if a
// word belongs to a { canonical: [...synonyms] } group, EVERY member of that
// group is added, not just the canonical form. Without this, "poultry" (the
// canonical) never expands to include "chicken" (a listed synonym), so
// comparing "Poultry" against "Chicken" would never reach full overlap.
export function normalizeWords(text, synonyms = {}) {
  const words = (text || "")
    .toLowerCase()
    .replace(/[^\w\s%.-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const groups = Object.entries(synonyms).map(([canonical, syns]) => [canonical, ...syns]);
  const expanded = new Set();
  for (const w of words) {
    expanded.add(w);
    for (const group of groups) {
      if (group.includes(w)) group.forEach((g) => expanded.add(g));
    }
  }
  return expanded;
}

export function extractNumbers(text) {
  return ((text || "").match(/[\d.]+/g) || []).map(Number);
}

export function numbersWithinTolerance(a, b, tolerancePercent) {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length !== b.length) return false;
  return a.every((n, i) => {
    if (b[i] === 0) return n === 0;
    return (Math.abs(n - b[i]) / Math.abs(b[i])) * 100 <= tolerancePercent;
  });
}

/**
 * Returns "exact" | "partial" | "wrong" | "notApplicable".
 * expected === null/undefined -> notApplicable (nothing to check).
 */
export function compareField(fieldPath, expected, actual, fieldTolerances = {}) {
  if (expected === null || expected === undefined) return "notApplicable";

  const expectedText = flattenToText(expected).trim();
  const actualText = flattenToText(actual).trim();
  if (!actualText) return "wrong";

  const normExpected = expectedText.toLowerCase().replace(/[^\w\s%.-]/g, " ").trim();
  const normActual = actualText.toLowerCase().replace(/[^\w\s%.-]/g, " ").trim();
  if (normExpected === normActual) return "exact";

  if (fieldTolerances.numericTolerancePercent !== undefined) {
    const expNums = extractNumbers(expectedText);
    const actNums = extractNumbers(actualText);
    if (expNums.length > 0 && numbersWithinTolerance(actNums, expNums, fieldTolerances.numericTolerancePercent)) {
      const expWords = normalizeWords(expectedText, fieldTolerances.synonyms);
      const actWords = normalizeWords(actualText, fieldTolerances.synonyms);
      const overlap = [...expWords].filter((w) => actWords.has(w)).length / Math.max(expWords.size, 1);
      if (overlap >= 0.4) return "exact";
    }
  }

  const expWords = normalizeWords(expectedText, fieldTolerances.synonyms);
  const actWords = normalizeWords(actualText, fieldTolerances.synonyms);
  const forwardOverlap = [...expWords].filter((w) => actWords.has(w)).length / Math.max(expWords.size, 1);
  const backwardOverlap = [...actWords].filter((w) => expWords.has(w)).length / Math.max(actWords.size, 1);

  // Full overlap in both directions after synonym expansion (e.g. "Poultry" vs
  // "Chicken" with a poultry<->chicken synonym group) is a real match, not a
  // partial one — the literal strings differ, but the meaning doesn't.
  if (forwardOverlap === 1 && backwardOverlap === 1) return "exact";
  if (Math.max(forwardOverlap, backwardOverlap) >= 0.6) return "partial";
  return "wrong";
}
