// Guards found missing by frontend integration testing, not by this suite:
// confirmField accepted undefined/empty values and overwrote extraction
// confidence; applyDirectPatch silently ignored overrideAcknowledged. All
// three are pure service-layer bugs — exercised directly against
// generatedLabelService, no HTTP/auth layer needed, matching how the
// existing patch-protocol tests call dryRunPatch directly.
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.js";
import * as versionService from "../src/services/label/versioning/versionService.js";
import * as generatedLabelService from "../src/services/label/generatedLabelService.js";
import { validate } from "../src/services/label/validation/validationEngine.js";

const baseLabelData = {
  schemaVersion: "vet-label@2.0.0", productType: "feed_additive",
  productName: { translations: { en: "GuardTest" }, primary: "en" }, pharmaceuticalForm: null, strength: null,
  feedClassification: { translations: { en: "Feed" }, primary: "en" },
  activeIngredients: [{ translations: { en: "A" }, primary: "en", amount: "10mg", unit: null, normalizedName: null }],
  excipients: [], analysis: null,
  targetAnimalSpecies: { translations: { en: "Dog" }, primary: "en", list: ["Dog"], source: "confirmed" },
  aimOfUse: { translations: { en: "Support" }, primary: "en" }, indications: [], routeOfAdministration: null,
  directionOfUse: { translations: { en: "1g/L" }, primary: "en" }, contraindications: null, warnings: [], sideEffects: null,
  withdrawalPeriod: null, userSafety: [], storage: { translations: { en: "Cool" }, primary: "en" }, shelfLifeAfterOpening: null,
  disposal: null, netWeight: { translations: { en: "1kg" }, primary: "en" }, packaging: null, registrationNumber: null,
  marketingAuthorisationHolder: null, manufacturer: null, importer: null, countryOfProduction: null, batchNo: null,
  productionDate: null, expiryDate: null, prescriptionStatus: "NA", usageDeclaration: [], keepOutOfReachOfChildren: true, estimatedFields: [],
};

async function seedLabel(company, extractionMeta = null) {
  const report = await validate(baseLabelData, { includePlausibility: false });
  const label = await versionService.createInitial({
    companyId: company.id, createdByUserId: "creator-user-id", inputPayload: {},
    labelData: baseLabelData, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "Egypt", language: "ar",
    matchTier: "none", generationMeta: {},
  });
  await prisma.validationReport.create({
    data: { labelId: label.id, versionNumber: 1, passed: report.passed, errorCount: report.errorCount, warningCount: report.warningCount, verdicts: report.verdicts, engineVersion: report.engineVersion, rulesetIds: [] },
  });
  if (extractionMeta) {
    await prisma.generatedLabel.update({ where: { id: label.id }, data: { extractionMeta } });
  }
  return label;
}

let company;
test.before(async () => {
  company = await prisma.company.create({ data: { name: `Guard Test Co ${Date.now()}`, username: `guard_test_${Date.now()}`, password: "x" } });
});
test.after(async () => {
  // GeneratedLabel -> LabelVersion/ValidationReport/LabelChatMessage and
  // Company -> GeneratedLabel are all onDelete: Cascade — deleting the
  // company is enough.
  await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
});

test("confirmField rejects undefined/null/empty value with 400, never writes it into labelData", async () => {
  const label = await seedLabel(company, { strength: { confidence: 0.42, snippet: "orig", bbox: [1, 2, 3, 4], ambiguous: true, confirmedByUser: false } });

  for (const badValue of [undefined, null, "", "   "]) {
    await assert.rejects(
      () => generatedLabelService.confirmField(label.id, { path: "strength", value: badValue, expectedVersion: 1, userId: "reviewer-1", companyId: company.id }),
      (err) => {
        assert.equal(err.statusCode, 400, `expected 400 for value=${JSON.stringify(badValue)}, got ${err.statusCode}`);
        return true;
      },
    );
  }

  // No version was created and labelData/extractionMeta are untouched.
  const fresh = await prisma.generatedLabel.findUnique({ where: { id: label.id } });
  assert.equal(fresh.currentVersion, 1, "a rejected confirmation must not create a version");
  assert.equal(fresh.labelData.strength, null, "labelData must be unchanged when the confirmed value is rejected");
  assert.equal(fresh.extractionMeta.strength.confidence, 0.42, "extractionMeta must be unchanged when the confirmed value is rejected");
});

test("confirmField writes a valid value, keeps original extraction confidence, and stamps confirmedValue/confirmedAt", async () => {
  const label = await seedLabel(company, { strength: { confidence: 0.42, snippet: "orig", bbox: [1, 2, 3, 4], ambiguous: true, confirmedByUser: false } });

  const result = await generatedLabelService.confirmField(label.id, {
    path: "strength",
    value: "50 mg/kg",
    expectedVersion: 1,
    userId: "reviewer-1",
    companyId: company.id,
  });

  assert.equal(result.label.strength, "50 mg/kg", "confirmed value must be written into labelData");
  const meta = result.extractionMeta.strength;
  assert.equal(meta.confidence, 0.42, "original extractor confidence must survive human confirmation");
  assert.equal(meta.confirmedByUser, true);
  assert.equal(meta.confirmedValue, "50 mg/kg");
  assert.ok(meta.confirmedAt && !Number.isNaN(Date.parse(meta.confirmedAt)), "confirmedAt must be a real timestamp");

  const fresh = await prisma.generatedLabel.findUnique({ where: { id: label.id } });
  assert.equal(fresh.currentVersion, 2);
  assert.equal(fresh.extractionMeta.strength.confidence, 0.42);
});

test("applyDirectPatch: a conflicting patch is refused without overrideAcknowledged, and applied — with the override recorded — when set", async () => {
  const label = await seedLabel(company);

  // Switching to Cattle makes withdrawalPeriod required (Dog is non-food-producing,
  // so the baseline doesn't already fail on it) — a genuinely NEW conflict.
  const changes = [{ path: "targetAnimalSpecies.list", op: "replace", value: ["Cattle"] }];

  const conflictResult = await generatedLabelService.applyDirectPatch(label.id, {
    changes,
    rationale: "Add cattle",
    expectedVersion: 1,
    userId: "editor-1",
    companyId: company.id,
  });
  assert.equal(conflictResult.status, "conflict", "a patch introducing a new FAIL must be refused, not silently applied");

  const afterConflict = await prisma.generatedLabel.findUnique({ where: { id: label.id } });
  assert.equal(afterConflict.currentVersion, 1, "a refused conflict must not create a version");

  const overriddenResult = await generatedLabelService.applyDirectPatch(label.id, {
    changes,
    rationale: "Add cattle",
    expectedVersion: 1,
    overrideAcknowledged: true,
    userId: "editor-1",
    companyId: company.id,
  });
  assert.equal(overriddenResult.status, "applied", "the SAME patch with overrideAcknowledged:true must actually apply");
  assert.equal(overriddenResult.resultVersion, 2);

  const newVersion = await prisma.labelVersion.findUnique({ where: { labelId_versionNumber: { labelId: label.id, versionNumber: 2 } } });
  assert.equal(newVersion.overrideAcknowledged, true, "the override must be persisted on the version");
  assert.equal(newVersion.changedByUserId, "editor-1", "the override must be tied to who made it");

  const afterOverride = await prisma.generatedLabel.findUnique({ where: { id: label.id } });
  assert.deepEqual(afterOverride.labelData.targetAnimalSpecies.list, ["Cattle"]);
});

test("applyDirectPatch: a structurally invalid patch is RETURNED as status:'refused' (200), never thrown as an HTTP error", async () => {
  const label = await seedLabel(company);

  const result = await generatedLabelService.applyDirectPatch(label.id, {
    changes: [{ path: "notARealField", op: "replace", value: "x" }],
    rationale: "test",
    expectedVersion: 1,
    userId: "editor-1",
    companyId: company.id,
  });

  assert.equal(result.status, "refused", "a refusal is a normal return value, not a thrown AppError");
  assert.equal(result.path, "notARealField");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
  assert.equal(result.previousValue, undefined, "notARealField was never a real field on the label");
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "full error list is preserved alongside the primary path/reason");

  const fresh = await prisma.generatedLabel.findUnique({ where: { id: label.id } });
  assert.equal(fresh.currentVersion, 1, "a refused patch must not create a version");
});
