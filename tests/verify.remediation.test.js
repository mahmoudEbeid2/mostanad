import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

test("§14.5.5 (T21) Remediations: Every FAIL carries structured remediation, restricted fields never guess", async () => {
  // Label missing mandatory fields and with conflicting units
  const badLabelData = {
    productName: { translations: { en: "Test Med" }, primary: "en" },
    pharmaceuticalForm: { translations: { en: "Liquid solution" }, primary: "en" },
    targetAnimalSpecies: { list: ["Cattle"], translations: { en: "Cattle" }, primary: "en" },
    aimOfUse: { translations: { en: "Treatment" }, primary: "en" },
    activeIngredients: [
      { normalizedName: "drug", primary: "Drug", amount: "500", unit: "g/kg" }, // contradiction: liquid form with g/kg
    ],
    // withdrawalPeriod is missing for a veterinary product on cattle
    storage: { translations: { en: "Store cool" }, primary: "en" },
    directionOfUse: { translations: { en: "Dose" }, primary: "en" },
  };

  const report = await validate(badLabelData, {
    rules: [
      {
        id: "rule-reg-1",
        ruleKey: "MANDATORY_LABEL_LANGUAGES",
        ruleType: "mandatory_clause",
        severity: "error",
        targetPath: "directionOfUse",
        constraint: { kind: "language_set", required: ["en", "ar"], appliesTo: "directionOfUse" },
        description: "directionOfUse must include both English and Arabic translations.",
      },
    ],
    includePlausibility: false,
  });

  const fails = report.verdicts.filter((v) => v.status === "FAIL");
  assert.ok(fails.length >= 2, "Should have multiple FAIL verdicts");

  for (const fail of fails) {
    assert.ok(fail.remediation, `FAIL verdict on ${fail.path} must have remediation`);
    assert.ok(["add", "correct", "review"].includes(fail.remediation.action), `Valid action on ${fail.path}`);
    assert.ok(["rule", "product_row", "reference", "none"].includes(fail.remediation.source), `Valid source on ${fail.path}`);

    // Invariant #5 / §8.2: Restricted fields MUST NEVER have a guessed suggested value
    if (["withdrawalPeriod", "strength", "registrationNumber"].includes(fail.path)) {
      if (fail.remediation.source !== "product_row" && fail.remediation.source !== "rule") {
        assert.equal(fail.remediation.suggested, null, `Restricted field ${fail.path} suggested must be null`);
      }
    }
  }

  // Check language_set rule failure remediation
  const langFail = report.verdicts.find((v) => v.ruleKey === "MANDATORY_LABEL_LANGUAGES");
  assert.ok(langFail);
  assert.equal(langFail.remediation.source, "rule");
  assert.equal(langFail.remediation.sourceRef.ruleKey, "MANDATORY_LABEL_LANGUAGES");
});
