import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

// §14.5.2 item 3: comparison was a raw string-equality check, so "None" vs
// "None." (a trailing full stop) reported a must-fix data_mismatch on
// regulated output. Normalise before comparing: trim, collapse whitespace,
// strip trailing punctuation, case-fold, and treat numbers-with-units as
// semantically equal regardless of spacing/decimal form.

const baseLabel = () => ({
  productName: { translations: { en: "Test Med" }, primary: "en" },
  pharmaceuticalForm: { translations: { en: "Oral liquid" }, primary: "en" },
  targetAnimalSpecies: { list: ["Cattle"], translations: { en: "Cattle" }, primary: "en" },
  aimOfUse: { translations: { en: "Treatment" }, primary: "en" },
  activeIngredients: [{ normalizedName: "drug", primary: "Drug", amount: "5 mg", unit: "mg" }],
  withdrawalPeriod: { translations: { en: "None" }, primary: "en" },
  storage: { translations: { en: "Store cool" }, primary: "en" },
  directionOfUse: { translations: { en: "Dose" }, primary: "en" },
});

async function mismatchFor(path, labelValue, productField, productValue) {
  const labelData = baseLabel();
  labelData[path] = { translations: { en: labelValue }, primary: "en" };
  const dbProduct = { id: "p1", name: "Test Med", [productField]: productValue };
  const report = await validate(labelData, { product: dbProduct, includePlausibility: false });
  return report.verdicts.find((v) => v.path === path && v.comparison === "data_mismatch");
}

test("§14.5.2 (T3) trailing punctuation is not a data_mismatch", async () => {
  const v = await mismatchFor("withdrawalPeriod", "None", "withdrawalPeriod", "None.");
  assert.equal(v, undefined, `"None" vs "None." must not be flagged, got: ${JSON.stringify(v)}`);
});

test("§14.5.2 (T3) case and whitespace differences are not a data_mismatch", async () => {
  const v = await mismatchFor("pharmaceuticalForm", "  Oral   Suspension ", "pharmaceuticalForm", "oral suspension");
  assert.equal(v, undefined, `case/whitespace-only differences must not be flagged, got: ${JSON.stringify(v)}`);
});

test("§14.5.2 (T3) 5 mg / 5mg / 5.0 mg are the same value", async () => {
  for (const [a, b] of [["5 mg", "5mg"], ["5mg", "5.0 mg"], ["5 mg", "5.0 mg"]]) {
    const v = await mismatchFor("strength", a, "strength", b);
    assert.equal(v, undefined, `"${a}" vs "${b}" must not be flagged, got: ${JSON.stringify(v)}`);
  }
});

test("§14.5.2 (T3) a real value difference still fails", async () => {
  const v = await mismatchFor("strength", "5 mg", "strength", "10 mg");
  assert.ok(v, "5 mg vs 10 mg must still be flagged as a data_mismatch");
  assert.equal(v.status, "FAIL");
});
