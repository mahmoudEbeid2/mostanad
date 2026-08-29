import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

test("§14.5.3 (T19) Extraction confidence: low confidence emits NEEDS_CONFIRMATION, not FAIL", async () => {
  const labelData = {
    productName: { translations: { en: "Unclear Drug Name" }, primary: "en" },
    strength: { translations: { en: "10 mg" }, primary: "en" },
    pharmaceuticalForm: { translations: { en: "Solution" }, primary: "en" },
    targetAnimalSpecies: { list: ["Cattle"], translations: { en: "Cattle" }, primary: "en" },
    aimOfUse: { translations: { en: "Antibiotic treatment" }, primary: "en" },
    activeIngredients: [{ normalizedName: "amoxicillin", primary: "Amoxicillin", amount: "10", unit: "mg/ml" }],
    withdrawalPeriod: { translations: { en: "Meat: 5 days" }, primary: "en" },
    storage: { translations: { en: "Store below 25C" }, primary: "en" },
    directionOfUse: { translations: { en: "Inject IM" }, primary: "en" },
  };

  const extractionMeta = {
    strength: {
      confidence: 0.45, // below 0.75 threshold
      snippet: "10 mg (faded)",
      bbox: [100, 200, 150, 250],
      ambiguous: true,
    },
  };

  const dbProduct = {
    id: "prod-123",
    name: "Unclear Drug Name",
    strength: "20 mg", // Differs, but should NOT cause FAIL because confidence is low
  };

  const report = await validate(labelData, {
    product: dbProduct,
    extractionMeta,
    confidenceThreshold: 0.75,
    includePlausibility: false,
  });

  const strengthVerdict = report.verdicts.find((v) => v.path === "strength");
  assert.ok(strengthVerdict, "Should emit a verdict for low confidence strength");
  assert.equal(strengthVerdict.status, "NEEDS_CONFIRMATION", "Low confidence must emit NEEDS_CONFIRMATION, not FAIL");
  assert.equal(strengthVerdict.layer, "extraction");
  assert.equal(strengthVerdict.comparison, "data_mismatch");
  assert.equal(strengthVerdict.confidence, 0.45);
  assert.ok(strengthVerdict.snippet.includes("faded"));

  // Check that strength was NOT marked as FAIL
  const failStrength = report.verdicts.filter((v) => v.path === "strength" && v.status === "FAIL");
  assert.equal(failStrength.length, 0, "Low confidence field must NOT be failed against product");
});
