import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

test("§14.5.4 (T22) No completion on verification: missing fields fail without auto-filling from web or model", async () => {
  // Label with missing withdrawalPeriod and missing registrationNumber
  const incompleteLabel = {
    productName: { translations: { en: "Antibiotic Injectable" }, primary: "en" },
    pharmaceuticalForm: { translations: { en: "Solution for injection" }, primary: "en" },
    targetAnimalSpecies: { list: ["Cattle"], translations: { en: "Cattle" }, primary: "en" },
    aimOfUse: { translations: { en: "Bacterial infections" }, primary: "en" },
    activeIngredients: [{ normalizedName: "tylosin", primary: "Tylosin", amount: "200", unit: "mg/ml" }],
    // withdrawalPeriod is omitted
    storage: { translations: { en: "Below 25C" }, primary: "en" },
    directionOfUse: { translations: { en: "1 ml per 10 kg" }, primary: "en" },
  };

  // Run validation
  const report = await validate(incompleteLabel, {
    includePlausibility: false,
  });

  // Check withdrawalPeriod
  const wpVerdict = report.verdicts.find((v) => v.path === "withdrawalPeriod");
  assert.ok(wpVerdict, "withdrawalPeriod verdict must exist");
  assert.equal(wpVerdict.status, "FAIL", "Missing withdrawalPeriod for food animals must FAIL");
  assert.equal(wpVerdict.presence, "MISSING");
  assert.equal(wpVerdict.remediation.action, "add");
  assert.equal(wpVerdict.remediation.suggested, null, "No external lookup should fill in withdrawal period");

  // Invariant #3: "Empty and FAIL beats guessed"
  assert.equal(report.passed, false);
  assert.ok(report.errorCount >= 1);
});
