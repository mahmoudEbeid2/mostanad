import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

test("§4.2 & §14.5 (T23) Engine parity: exact same labelData yields identical verdicts whether extracted or generated", async () => {
  const sampleLabelData = {
    productName: { translations: { en: "Ampicillin 20%", ar: "أمبيسيلين 20%" }, primary: "en" },
    pharmaceuticalForm: { translations: { en: "Powder for oral solution", ar: "مسحوق للحل في ماء الشرب" }, primary: "en" },
    targetAnimalSpecies: { list: ["Chickens", "Turkeys"], translations: { en: "Chickens, Turkeys", ar: "الدجاج، الرومي" }, primary: "en" },
    aimOfUse: { translations: { en: "Treatment of respiratory infections", ar: "علاج الالتهابات التنفسية" }, primary: "en" },
    activeIngredients: [
      { normalizedName: "ampicillin trihydrate", primary: "Ampicillin Trihydrate", amount: "200", unit: "g/kg" },
    ],
    withdrawalPeriod: { translations: { en: "Meat: 3 days", ar: "اللحم: 3 أيام" }, primary: "en" },
    storage: { translations: { en: "Store below 25C in dry place", ar: "يحفظ تحت 25 درجة مئوية في مكان جاف" }, primary: "en" },
    directionOfUse: { translations: { en: "1g per 2L of drinking water", ar: "1 جم لكل 2 لتر ماء شرب" }, primary: "en" },
  };

  const rules = [
    {
      id: "rule-1",
      ruleKey: "STORAGE_REQUIRED",
      ruleType: "mandatory_clause",
      severity: "error",
      targetPath: "storage",
      constraint: { kind: "required_field", path: "storage" },
      description: "storage is required.",
    },
  ];

  // Run as "generated label"
  const reportGenerated = await validate(sampleLabelData, {
    rules,
    includePlausibility: false,
  });

  // Run as "extracted label" (with extractionMeta where all fields have confidence 1.0)
  const extractionMeta = {
    productName: { confidence: 0.99, snippet: "Ampicillin 20%" },
    pharmaceuticalForm: { confidence: 0.98, snippet: "Powder for oral solution" },
    targetAnimalSpecies: { confidence: 0.95, snippet: "Chickens, Turkeys" },
    aimOfUse: { confidence: 0.95, snippet: "Treatment of respiratory infections" },
    activeIngredients: { confidence: 0.95, snippet: "Ampicillin Trihydrate 200 g/kg" },
    withdrawalPeriod: { confidence: 0.95, snippet: "Meat: 3 days" },
    storage: { confidence: 0.95, snippet: "Store below 25C in dry place" },
    directionOfUse: { confidence: 0.95, snippet: "1g per 2L of drinking water" },
  };

  const reportExtracted = await validate(sampleLabelData, {
    rules,
    extractionMeta,
    includePlausibility: false,
  });

  // Engine parity assertions
  assert.equal(reportGenerated.passed, reportExtracted.passed, "Pass/fail outcome must be identical");
  assert.equal(reportGenerated.errorCount, reportExtracted.errorCount, "Error count must be identical");
  assert.equal(reportGenerated.warningCount, reportExtracted.warningCount, "Warning count must be identical");
  assert.equal(reportGenerated.verdicts.length, reportExtracted.verdicts.length, "Number of verdicts must be identical");

  for (let i = 0; i < reportGenerated.verdicts.length; i++) {
    const vGen = reportGenerated.verdicts[i];
    const vExt = reportExtracted.verdicts.find((v) => v.path === vGen.path && v.ruleKey === vGen.ruleKey);
    assert.ok(vExt, `Extracted report must contain verdict matching path=${vGen.path} ruleKey=${vGen.ruleKey}`);
    assert.equal(vGen.status, vExt.status, `Status for ${vGen.path} must match`);
    assert.equal(vGen.comparison, vExt.comparison, `Comparison for ${vGen.path} must match`);
  }
});
