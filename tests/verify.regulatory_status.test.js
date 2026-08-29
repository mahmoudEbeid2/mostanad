import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

// §14.5.4/#4: no approved ruleset for the country must be stated as
// UNVERIFIABLE, not silently treated as "nothing wrong". ruleValidator
// already emits a single UNVERIFIABLE "_regulatory" verdict for an empty
// ruleset (§7.1 case 4) — this locks that behavior in so labelService's
// top-level regulatoryStatus (CHECKED vs UNVERIFIABLE) has something real to
// derive from, and never collapses "we never checked" into "it passed".

const minimalLabel = () => ({
  productName: { translations: { en: "Test Med" }, primary: "en" },
  pharmaceuticalForm: { translations: { en: "Oral liquid" }, primary: "en" },
  targetAnimalSpecies: { list: ["Cattle"], translations: { en: "Cattle" }, primary: "en" },
  aimOfUse: { translations: { en: "Treatment" }, primary: "en" },
  activeIngredients: [{ normalizedName: "drug", primary: "Drug", amount: "5 mg", unit: "mg" }],
  storage: { translations: { en: "Store cool" }, primary: "en" },
  directionOfUse: { translations: { en: "Dose" }, primary: "en" },
});

test("§14.5.4 (item 4) no approved ruleset -> a real UNVERIFIABLE regulatory verdict, not silence", async () => {
  const report = await validate(minimalLabel(), { rules: [], includePlausibility: false });
  const regVerdict = report.verdicts.find((v) => v.ruleKey === "NO_AUTHORITATIVE_REQUIREMENTS");
  assert.ok(regVerdict, "must emit a verdict when no rules were checked");
  assert.equal(regVerdict.status, "UNVERIFIABLE");
  assert.notEqual(regVerdict.status, "PASS");
  assert.equal(regVerdict.comparison, "regulatory");
  assert.equal(report.rulesetIds.length, 0);
});

test("§14.5.4 (item 4) an approved ruleset is actually applied, not schema-only", async () => {
  const rules = [{
    id: "rule-1",
    ruleKey: "SA.VET.WITHDRAWAL.REQUIRED_IF_FOOD",
    ruleType: "mandatory_field",
    severity: "error",
    constraint: { kind: "required_field", path: "withdrawalPeriod" },
    description: "Withdrawal period is required.",
  }];
  const report = await validate(minimalLabel(), { rules, includePlausibility: false });
  const ruleVerdict = report.verdicts.find((v) => v.ruleKey === "SA.VET.WITHDRAWAL.REQUIRED_IF_FOOD");
  assert.ok(ruleVerdict, "the approved rule must actually run");
  assert.equal(ruleVerdict.status, "FAIL", "withdrawalPeriod is missing from minimalLabel()");
  assert.equal(ruleVerdict.comparison, "regulatory");
  assert.equal(report.rulesetIds.length, 1);
});
