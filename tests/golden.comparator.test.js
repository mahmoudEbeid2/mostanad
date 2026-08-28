// Proves the golden-set scoring logic itself (scripts/goldenComparator.js) is
// correct, independent of the live pipeline / Gemini quota. This is the part
// evalGolden.js's own live run against golden/ couldn't prove today — quota was
// exhausted, so both fixture cases errored before generation, never reaching
// the scorer. This test exercises the scorer directly.
import { compareField } from "../scripts/goldenComparator.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m" };
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { console.log(`${colors.green}  PASS: ${label}${colors.reset}`); passed++; }
  else { console.log(`${colors.red}  FAIL: ${label}${colors.reset}`, details); failed++; }
}

console.log("\n=== Golden set comparator unit tests ===\n");

// notApplicable: expected is null.
assert("null expected -> notApplicable", compareField("x", null, { en: "anything" }) === "notApplicable");

// wrong: actual missing entirely.
assert("missing actual -> wrong", compareField("x", { en: "Poultry" }, null) === "wrong");

// exact: identical text (case/whitespace-insensitive).
assert("identical text -> exact", compareField("x", { en: "Store below 25C" }, { en: "  store BELOW 25c  " }) === "exact");

// wrong: completely different text, no overlap.
assert("no overlap -> wrong", compareField("x", { en: "Store below 25C" }, { en: "Completely unrelated content here" }) === "wrong");

// partial: significant word overlap but not identical.
assert(
  "high word overlap, not identical -> partial",
  compareField("x", { en: "Treatment of bacterial infections in poultry" }, { en: "Treatment of bacterial infections affecting poultry flocks" }) === "partial"
);

// synonym-aware: species name differs but tolerances map it.
assert(
  "synonym match via tolerances -> exact",
  compareField("targetAnimalSpecies", { en: "Poultry" }, { en: "Chicken" }, { synonyms: { poultry: ["chicken", "broiler"] } }) === "exact"
);

// numeric tolerance: dosage numbers close enough + reasonable word overlap -> exact.
assert(
  "numbers within tolerance + word overlap -> exact",
  compareField(
    "directionOfUse",
    { en: "1g per 10kg body weight in drinking water for 5 days" },
    { en: "1g per 10.5kg body weight in drinking water for 5 days" },
    { numericTolerancePercent: 10 }
  ) === "exact"
);

// numeric tolerance: numbers too far apart -> not exact (falls through to overlap scoring).
assert(
  "numbers outside tolerance -> not exact",
  compareField(
    "directionOfUse",
    { en: "1g per 10kg body weight" },
    { en: "5g per 10kg body weight" },
    { numericTolerancePercent: 10 }
  ) !== "exact"
);

// Arrays (ingredients-shaped): compares flattened joined text.
assert(
  "array fields flatten and compare",
  compareField(
    "ingredients",
    [{ en: "Amoxicillin Trihydrate", amount: "100 g" }],
    [{ en: "Amoxicillin Trihydrate", amount: "100 g" }]
  ) === "exact"
);

// analysis-shaped object (basis + items).
assert(
  "analysis object flattens and compares",
  compareField(
    "analysis",
    { basis: "per 1 kg", items: [{ name: "Vitamin A", value: "500000 IU" }] },
    { basis: "per 1 kg", items: [{ name: "Vitamin A", value: "500000 IU" }] }
  ) === "exact"
);

console.log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
