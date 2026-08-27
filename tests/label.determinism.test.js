// T10 (§17) — layers 1-4 of validationEngine must be pure: same labelData + same
// rulesetIds + same engineVersion => identical verdicts, every time. No server,
// no DB, no Gemini call needed — this is exactly the point: these layers are
// deterministic code, not AI.
import { validate } from "../src/services/label/validation/validationEngine.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m" };
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { console.log(`${colors.green}  PASS: ${label}${colors.reset}`); passed++; }
  else { console.log(`${colors.red}  FAIL: ${label}${colors.reset}`, details); failed++; }
}

const baseLabel = {
  schemaVersion: "vet-label@2.0.0",
  productType: "feed_additive",
  productName: { translations: { en: "TestVit" }, primary: "en" },
  pharmaceuticalForm: null,
  strength: null,
  feedClassification: { translations: { en: "Feed Additive" }, primary: "en" },
  activeIngredients: [{ translations: { en: "Vitamin C" }, primary: "en", amount: "10 g", unit: "g", normalizedName: "vitamin c" }],
  excipients: [],
  analysis: { basis: "per 1 kg", items: [{ name: "Vitamin C", value: "10 g" }] },
  targetAnimalSpecies: { translations: { en: "Poultry" }, primary: "en", list: ["Poultry"], source: "reference" },
  aimOfUse: { translations: { en: "Supports immunity" }, primary: "en" },
  indications: [],
  routeOfAdministration: null,
  directionOfUse: { translations: { en: "1g per L" }, primary: "en" },
  contraindications: null,
  warnings: [],
  sideEffects: null,
  withdrawalPeriod: null,
  userSafety: [],
  storage: { translations: { en: "Store below 25C" }, primary: "en" },
  shelfLifeAfterOpening: null,
  disposal: null,
  netWeight: { translations: { en: "25kg" }, primary: "en" },
  packaging: { translations: { en: "25kg drum" }, primary: "en" },
  registrationNumber: null,
  marketingAuthorisationHolder: null,
  manufacturer: null,
  importer: null,
  countryOfProduction: null,
  batchNo: null,
  productionDate: null,
  expiryDate: null,
  prescriptionStatus: "NA",
  usageDeclaration: [],
  keepOutOfReachOfChildren: true,
  estimatedFields: [],
};

const fixtureRules = [
  {
    id: "rule_1",
    ruleKey: "TEST.NO_CURE_CLAIM",
    ruleType: "forbidden_content",
    severity: "error",
    appliesWhen: null,
    constraint: { kind: "forbidden_content", path: "aimOfUse", patterns: ["\\bcures?\\b"], flags: "i" },
    description: "No curative claims allowed.",
    citation: "Test fixture clause 1",
  },
];

console.log("\n=== T10: Determinism of validation layers 1-4 ===\n");

// Same input, same rules, run twice -> identical verdicts.
const r1 = validate(baseLabel, { rules: fixtureRules });
const r2 = validate(baseLabel, { rules: fixtureRules });
assert("Same labelData + same rules -> identical verdicts JSON", JSON.stringify(r1.verdicts) === JSON.stringify(r2.verdicts));
assert("Same labelData + same rules -> identical passed/errorCount/warningCount", r1.passed === r2.passed && r1.errorCount === r2.errorCount && r1.warningCount === r2.warningCount);

// Different object reference, same content -> still identical (proves no reliance on identity/order-of-keys).
const clone = JSON.parse(JSON.stringify(baseLabel));
const r3 = validate(clone, { rules: fixtureRules });
assert("Structurally-equal but distinct object -> identical verdicts", JSON.stringify(r1.verdicts) === JSON.stringify(r3.verdicts));

// A real change in input must change the output (sanity: this isn't trivially "always the same").
const changed = { ...baseLabel, aimOfUse: { translations: { en: "This product cures infections" }, primary: "en" } };
const r4 = validate(changed, { rules: fixtureRules });
assert("Changing labelData changes verdicts (not a constant function)", JSON.stringify(r1.verdicts) !== JSON.stringify(r4.verdicts));
assert("Forbidden-content rule fires on the changed input", r4.verdicts.some((v) => v.ruleKey === "TEST.NO_CURE_CLAIM" && v.status === "FAIL"));
assert("Forbidden-content rule does not fire on the unchanged input", !r1.verdicts.some((v) => v.ruleKey === "TEST.NO_CURE_CLAIM" && v.status === "FAIL"));

// engineVersion is stamped and stable across runs.
assert("engineVersion present and stable", r1.engineVersion === r2.engineVersion && !!r1.engineVersion);

console.log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
process.exit(failed > 0 ? 1 : 0);
