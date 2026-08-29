import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

test("§14.5.1 & §14.5.2 (T20) 3-way verification vs 2-way verification and comparison discriminants", async () => {
  const labelData = {
    productName: { translations: { en: "Panacur 10%" }, primary: "en" },
    strength: { translations: { en: "100 mg/ml" }, primary: "en" },
    pharmaceuticalForm: { translations: { en: "Oral suspension" }, primary: "en" },
    targetAnimalSpecies: { list: ["Sheep"], translations: { en: "Sheep" }, primary: "en" },
    aimOfUse: { translations: { en: "Dewormer" }, primary: "en" },
    activeIngredients: [{ normalizedName: "fenbendazole", primary: "Fenbendazole", amount: "100", unit: "mg/ml" }],
    withdrawalPeriod: { translations: { en: "Meat: 14 days" }, primary: "en" },
    storage: { translations: { en: "Store below 30C" }, primary: "en" },
    directionOfUse: { translations: { en: "Oral dose" }, primary: "en" },
  };

  // Case 1: 2-way verification (no product passed)
  const report2Way = await validate(labelData, {
    product: null,
    includePlausibility: false,
  });
  const dataMismatch2Way = report2Way.verdicts.filter((v) => v.comparison === "data_mismatch");
  assert.equal(dataMismatch2Way.length, 0, "2-way verification must not have product data_mismatch verdicts");

  // Case 2: 3-way verification (product passed with mismatch on strength and withdrawalPeriod)
  const dbProduct = {
    id: "prod-456",
    name: "Panacur 10%",
    strength: "200 mg/ml", // Mismatch: label states 100 mg/ml
    withdrawalPeriod: "Meat: 21 days", // Mismatch: label states 14 days
  };

  const report3Way = await validate(labelData, {
    product: dbProduct,
    includePlausibility: false,
  });

  const strengthMismatch = report3Way.verdicts.find((v) => v.path === "strength" && v.comparison === "data_mismatch");
  assert.ok(strengthMismatch, "Should emit data_mismatch for strength");
  assert.equal(strengthMismatch.status, "FAIL");
  assert.equal(strengthMismatch.layer, "product_match");
  assert.equal(strengthMismatch.remediation.action, "correct");
  assert.equal(strengthMismatch.remediation.suggested, "200 mg/ml");
  assert.equal(strengthMismatch.remediation.source, "product_row");
  assert.equal(strengthMismatch.remediation.sourceRef.productId, "prod-456");

  const wpMismatch = report3Way.verdicts.find((v) => v.path === "withdrawalPeriod" && v.comparison === "data_mismatch");
  assert.ok(wpMismatch, "Should emit data_mismatch for withdrawalPeriod");
  assert.equal(wpMismatch.status, "FAIL");
  assert.equal(wpMismatch.remediation.suggested, "Meat: 21 days");
  assert.equal(wpMismatch.remediation.source, "product_row");

  // Verify comparison discriminants across layers
  const coherenceVerdicts = report3Way.verdicts.filter((v) => v.comparison === "coherence");
  assert.ok(coherenceVerdicts.length > 0, "Must have coherence comparison verdicts");
  const regulatoryVerdicts = report3Way.verdicts.filter((v) => v.comparison === "regulatory");
  assert.ok(regulatoryVerdicts.length > 0, "Must have regulatory comparison verdicts");
});
