// Phase 6's patch protocol (§11.3/§11.4) — all pure, no AI call needed for any
// of this. T6/T7's core logic: apply, path allowlist, bulk-replacement guard,
// dry-run, and conflict detection (a patch that introduces a NEW FAIL must
// never apply silently).
import { applyPatch, validatePatchShape, isValidPatchPath } from "../src/services/label/editing/patchProtocol.js";
import { dryRunPatch } from "../src/services/label/editing/patchApplier.js";
import { validate } from "../src/services/label/validation/validationEngine.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

log("\n=== Phase 6: patch protocol (apply, guards, dry-run, conflict) ===\n", "bold");

// ── applyPatch ───────────────────────────────────────────────────────────────
log("-- applyPatch ops (replace/append/remove/insert) --", "cyan");
const base = {
  targetAnimalSpecies: { translations: { en: "Poultry" }, primary: "en", list: ["Poultry"], source: "reference" },
  warnings: [{ translations: { en: "Wash hands" }, primary: "en" }],
  activeIngredients: [{ translations: { en: "A" }, primary: "en", amount: "10mg" }, { translations: { en: "B" }, primary: "en", amount: "20mg" }],
};

const replaced = applyPatch(base, [{ path: "targetAnimalSpecies.list", op: "replace", value: ["Cattle", "Sheep"] }]);
assert("replace sets a nested path", JSON.stringify(replaced.targetAnimalSpecies.list) === JSON.stringify(["Cattle", "Sheep"]));
assert("replace does not mutate the original object", JSON.stringify(base.targetAnimalSpecies.list) === JSON.stringify(["Poultry"]));

const appended = applyPatch(base, [{ path: "warnings", op: "append", value: { translations: { en: "New warning" }, primary: "en" } }]);
assert("append adds to an array", appended.warnings.length === 2);

const removed = applyPatch(base, [{ path: "warnings[0]", op: "remove" }]);
assert("remove deletes an array element by index", removed.warnings.length === 0);

const inserted = applyPatch(base, [{ path: "activeIngredients[1]", op: "insert", value: { translations: { en: "C" }, primary: "en", amount: "5mg" } }]);
assert("insert splices into an array at index", inserted.activeIngredients.length === 3 && inserted.activeIngredients[1].translations.en === "C");

const amountReplaced = applyPatch(base, [{ path: "activeIngredients[1].amount", op: "replace", value: "500 mg" }]);
assert("replace works on an array-indexed nested path", amountReplaced.activeIngredients[1].amount === "500 mg");

// ── Path allowlist + shape validation (§11.4 guard #1) ──────────────────────
log("\n-- Path allowlist + shape guards --", "cyan");
assert("A real labelSchema field is a valid patch path", isValidPatchPath("withdrawalPeriod"));
assert("A nested/indexed path resolves by its top segment", isValidPatchPath("activeIngredients[0].amount"));
assert("An unknown field is rejected, not silently ignored", !isValidPatchPath("thisFieldDoesNotExist"));

const unknownPathPatch = { rationale: "test", changes: [{ path: "notAField", op: "replace", value: "x" }] };
const unknownPathResult = validatePatchShape(unknownPathPatch);
assert("Patch with an unknown path fails shape validation", !unknownPathResult.ok);
assert("Error message names the offending path", unknownPathResult.errors.some((e) => e.includes("notAField")));

const badOpPatch = { rationale: "test", changes: [{ path: "storage", op: "overwrite_everything", value: "x" }] };
assert("Patch with an unsupported op is rejected", !validatePatchShape(badOpPatch).ok);

// Bulk-replacement guard (§11.4 guard #2): touch > 60% of top-level fields.
const allFields = Object.keys(base).concat(["schemaVersion", "productType", "productName", "pharmaceuticalForm", "strength", "feedClassification", "excipients", "analysis", "aimOfUse", "indications", "routeOfAdministration", "directionOfUse", "contraindications", "sideEffects", "withdrawalPeriod", "userSafety", "storage", "shelfLifeAfterOpening", "disposal", "netWeight", "packaging", "registrationNumber", "marketingAuthorisationHolder", "manufacturer", "importer", "countryOfProduction", "batchNo", "productionDate", "expiryDate", "prescriptionStatus", "usageDeclaration", "keepOutOfReachOfChildren", "estimatedFields"]);
const bulkPatch = { rationale: "test", changes: [...new Set(allFields)].map((f) => ({ path: f, op: "replace", value: null })) };
assert("A patch touching most top-level fields is rejected as a bulk replacement", !validatePatchShape(bulkPatch).ok);

const smallPatch = { rationale: "test", changes: [{ path: "storage", op: "replace", value: { translations: { en: "Store cold" }, primary: "en" } }] };
assert("A small, targeted patch passes shape validation", validatePatchShape(smallPatch).ok);

// ── dryRunPatch: clean vs. conflict (§11.4 guard #3-4) ──────────────────────
log("\n-- dryRunPatch: clean apply vs. conflict detection --", "cyan");
const currentLabel = {
  schemaVersion: "vet-label@2.0.0", productType: "feed_additive",
  productName: { translations: { en: "X" }, primary: "en" }, pharmaceuticalForm: null, strength: null,
  feedClassification: { translations: { en: "Feed" }, primary: "en" },
  activeIngredients: [{ translations: { en: "A" }, primary: "en", amount: "10mg", unit: null, normalizedName: null }],
  excipients: [], analysis: null,
  targetAnimalSpecies: { translations: { en: "Poultry" }, primary: "en", list: ["Poultry"], source: "reference" },
  aimOfUse: { translations: { en: "Support" }, primary: "en" }, indications: [], routeOfAdministration: null,
  directionOfUse: { translations: { en: "1g/L" }, primary: "en" }, contraindications: null, warnings: [], sideEffects: null,
  withdrawalPeriod: null, userSafety: [], storage: { translations: { en: "Cool" }, primary: "en" }, shelfLifeAfterOpening: null,
  disposal: null, netWeight: { translations: { en: "1kg" }, primary: "en" }, packaging: null, registrationNumber: null,
  marketingAuthorisationHolder: null, manufacturer: null, importer: null, countryOfProduction: null, batchNo: null,
  productionDate: null, expiryDate: null, prescriptionStatus: "NA", usageDeclaration: [], keepOutOfReachOfChildren: true, estimatedFields: [],
};

// dryRunPatch's contract expects the caller's ACTUAL current report (the
// controller always fetches this for real) — compute a real baseline here too,
// not a hand-stubbed one, so "new vs. pre-existing" failures are judged fairly.
const baselineReport = validate(currentLabel);

const cleanPatch = { rationale: "Update storage instructions", changes: [{ path: "storage", op: "replace", value: { translations: { en: "Store below 25C" }, primary: "en" } }] };
const cleanResult = dryRunPatch(currentLabel, baselineReport, cleanPatch);
assert("A patch that doesn't introduce a new FAIL is 'clean'", cleanResult.status === "clean", cleanResult);
assert("Clean result carries the candidate label with the change applied", cleanResult.candidateLabelData.storage.translations.en === "Store below 25C");

// Switching to Cattle makes withdrawalPeriod required (fieldCatalog) — this
// SHOULD be flagged as a conflict since it's a NEW failure the current label doesn't have.
// Starts from a NON-food-producing species (Poultry is also food-producing, so
// reusing currentLabel here would make withdrawalPeriod already-failing, not new).
const dogLabel = { ...currentLabel, targetAnimalSpecies: { translations: { en: "Dog" }, primary: "en", list: ["Dog"], source: "reference" } };
const dogBaselineReport = validate(dogLabel);
assert("Sanity: withdrawalPeriod is NOT required for a non-food-producing species baseline", !dogBaselineReport.verdicts.some((v) => v.path === "withdrawalPeriod" && v.status === "FAIL"));

const conflictPatch = { rationale: "Add cattle as a target species", changes: [{ path: "targetAnimalSpecies.list", op: "replace", value: ["Cattle"] }] };
const conflictResult = dryRunPatch(dogLabel, dogBaselineReport, conflictPatch);
assert("A patch introducing a new required-field FAIL is a 'conflict', not silently applied", conflictResult.status === "conflict", conflictResult);
assert("Conflict result names the violated rule/path", conflictResult.wouldViolate?.some((v) => v.path === "withdrawalPeriod"));
assert("Conflict options include cancel and override, never a silent apply", conflictResult.options?.includes("cancel") && conflictResult.options?.includes("apply_anyway_with_override"));

// A patch is judged against what was ALREADY failing — pre-existing failures
// don't make every subsequent edit look like a "new" conflict.
const cattleAlreadyLabel = { ...currentLabel, targetAnimalSpecies: { translations: { en: "Cattle" }, primary: "en", list: ["Cattle"], source: "reference" } };
const cattleAlreadyReport = validate(cattleAlreadyLabel); // withdrawalPeriod already FAILs here
const stillCattlePatch = { rationale: "test", changes: [{ path: "targetAnimalSpecies.list", op: "replace", value: ["Cattle", "Sheep"] }] };
const noNewConflictResult = dryRunPatch(cattleAlreadyLabel, cattleAlreadyReport, stillCattlePatch);
assert("Pre-existing failure on the same path isn't re-flagged as a NEW conflict", noNewConflictResult.status === "clean", noNewConflictResult);

const invalidPatch = { rationale: "test", changes: [{ path: "notReal", op: "replace", value: "x" }] };
assert("An invalid patch never reaches apply/dry-run — status 'invalid'", dryRunPatch(currentLabel, baselineReport, invalidPatch).status === "invalid");

log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
process.exit(failed > 0 ? 1 : 0);
