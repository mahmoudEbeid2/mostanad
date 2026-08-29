import test from "node:test";
import assert from "node:assert/strict";
import { buildSpeciesExtractionMeta } from "../src/services/label/extraction/labelExtractor.js";
import { validate } from "../src/services/label/validation/validationEngine.js";

// §14.5.3/#5: species were shown as pictograms (chicken, cattle, sheep, horse,
// camel) rather than text, extraction found nothing, and the result silently
// said "Unknown" — no verdict at all flagged that the field was unread. A
// required field the extractor could not read must be NEEDS_CONFIRMATION with
// the region shown, never a silent "Unknown".

test("§14.5 (item 5) empty species extraction gets confidence 0, not silently dropped", () => {
  const meta = buildSpeciesExtractionMeta({ targetAnimalSpeciesList: [] });
  assert.equal(meta.confidence, 0);
  assert.equal(meta.ambiguous, true);
});

test("§14.5 (item 5) a real species read keeps its own confidence/region", () => {
  const meta = buildSpeciesExtractionMeta({
    targetAnimalSpeciesList: ["Chicken", "Cattle"],
    extractionMeta: { targetAnimalSpeciesList: { confidence: 0.92, ambiguous: false, region: "pictogram row, top of label" } },
  });
  assert.equal(meta.confidence, 0.92);
  assert.equal(meta.region, "pictogram row, top of label");
});

test("§14.5 (item 5) unread species produce NEEDS_CONFIRMATION end to end, not a silent PASS", async () => {
  const labelData = {
    productName: { translations: { en: "ADD-E120" }, primary: "en" },
    pharmaceuticalForm: { translations: { en: "Oral liquid" }, primary: "en" },
    strength: { translations: { en: "120000 mg/L" }, primary: "en" },
    // Extraction couldn't read the pictogram row — mapToLabelData's fallback shape:
    targetAnimalSpecies: { translations: { en: "Unknown" }, primary: "en", list: ["Unknown"], source: "inferred" },
    aimOfUse: { translations: { en: "Vitamin E and selenium supplementation" }, primary: "en" },
    activeIngredients: [
      { normalizedName: "vitamin e", primary: "Vitamin E", amount: "120000", unit: "mg/L" },
      { normalizedName: "sodium selenite", primary: "Sodium Selenite", amount: "60", unit: "mg/L" },
    ],
    storage: { translations: { en: "Store below 25C" }, primary: "en" },
    directionOfUse: { translations: { en: "Add to drinking water" }, primary: "en" },
  };

  const extractionMeta = { targetAnimalSpecies: buildSpeciesExtractionMeta({ targetAnimalSpeciesList: [] }) };

  const report = await validate(labelData, { extractionMeta, includePlausibility: false });

  const speciesVerdict = report.verdicts.find((v) => v.path === "targetAnimalSpecies");
  assert.ok(speciesVerdict, "targetAnimalSpecies must produce a verdict");
  assert.equal(speciesVerdict.status, "NEEDS_CONFIRMATION", "unread species must be NEEDS_CONFIRMATION, not a silent PASS/Unknown");
  assert.notEqual(speciesVerdict.status, "PASS");
});
