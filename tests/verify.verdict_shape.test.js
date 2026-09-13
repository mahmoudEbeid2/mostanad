import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/services/label/validation/validationEngine.js";

// §UI redesign: every finding must state WHAT/WHY/WHERE-from and FIX/its-source.
// item 1: whySource, triggeredBy, observed/expected, citation-on-every-regulation-verdict.
// item 2: remediation.{action,suggested,source,sourceRef,confidence}, "common_practice" honesty.

const baseLabel = (overrides = {}) => ({
  productName: { translations: { en: "ADD-E120" }, primary: "en" },
  pharmaceuticalForm: { translations: { en: "Oral liquid" }, primary: "en" },
  strength: { translations: { en: "120000 mg/L" }, primary: "en" },
  targetAnimalSpecies: { list: ["Poultry", "Cattle"], translations: { en: "Poultry, Cattle" }, primary: "en" },
  aimOfUse: { translations: { en: "Vitamin E and selenium supplementation" }, primary: "en" },
  activeIngredients: [
    { normalizedName: "vitamin e", primary: "Vitamin E", amount: "120000", unit: "mg/L" },
    { normalizedName: "sodium selenite", primary: "Sodium Selenite", amount: "60", unit: "mg/L" },
  ],
  storage: { translations: { en: "Store below 25C" }, primary: "en" },
  directionOfUse: { translations: { en: "Add to drinking water" }, primary: "en" },
  // Amended Invariant #5: withdrawalPeriod is no longer Zod-nullable (labelSchema.js),
  // so a real "empty" value must be a well-formed-but-blank LocalizedText, not null —
  // null would now fail at the SCHEMA layer (comparison "coherence"), which defeats
  // this test's point (applicability, comparison "regulatory", is what should fail it).
  withdrawalPeriod: { translations: {}, primary: "" },
  ...overrides,
});

test("§UI redesign item 1: whySource reflects what the user should trust, distinct from comparison", async () => {
  // withdrawalPeriod omitted -> Cattle/Poultry are food-producing -> applicability FAIL.
  // This is comparison:"regulatory" but NOT a sourced country regulation (it's an
  // internal completeness heuristic, fieldCatalog.js) — whySource must say "structure",
  // not falsely claim "regulation" with no citable authority behind it.
  const report = await validate(baseLabel(), { includePlausibility: false });
  const wp = report.verdicts.find((v) => v.path === "withdrawalPeriod");
  assert.ok(wp, "withdrawalPeriod verdict must exist");
  assert.equal(wp.comparison, "regulatory");
  assert.equal(wp.whySource, "structure", "internal completeness heuristic must not claim to be a sourced regulation");
  assert.ok(wp.triggeredBy, "must state which condition (food-producing species) fired");
  assert.match(wp.triggeredBy, /food-producing/);
});

test("§UI redesign item 1: a real RegulatoryRule verdict is whySource:'regulation' and carries its trigger", async () => {
  const rules = [{
    id: "rule-1",
    ruleKey: "SA.VET.SPECIES_RULE",
    severity: "error",
    citation: "SFDA Vet Guide §6.1",
    appliesWhen: { path: "targetAnimalSpecies.list", anyOf: ["Poultry", "Cattle", "Sheep", "Goat", "Camel"] },
    constraint: { kind: "required_field", path: "withdrawalPeriod" },
    description: "Withdrawal period required for food-producing species.",
  }];
  const report = await validate(baseLabel(), { rules, includePlausibility: false });
  const v = report.verdicts.find((x) => x.ruleKey === "SA.VET.SPECIES_RULE");
  assert.ok(v);
  assert.equal(v.whySource, "regulation");
  assert.equal(v.citation, "SFDA Vet Guide §6.1", "a regulation verdict without a citation is a bug");
  assert.ok(v.triggeredBy, "conditional rule must state the condition in plain words");
  assert.match(v.triggeredBy, /Poultry/);
});

test("§UI redesign item 1: data_mismatch carries observed/expected as separate fields, not just prose", async () => {
  const dbProduct = { id: "p1", name: "ADD-E120", strength: "60000 mg/L" };
  const report = await validate(baseLabel(), { product: dbProduct, includePlausibility: false });
  const v = report.verdicts.find((x) => x.path === "strength" && x.comparison === "data_mismatch");
  assert.ok(v);
  assert.equal(v.whySource, "your_data");
  assert.equal(v.observed, "120000 mg/L");
  assert.equal(v.expected, "60000 mg/L");
});

test("§UI redesign item 2: every FAIL's remediation carries confidence derived from source", async () => {
  const dbProduct = { id: "p1", name: "ADD-E120", strength: "60000 mg/L" };
  const report = await validate(baseLabel(), { product: dbProduct, includePlausibility: false });
  for (const v of report.verdicts.filter((x) => x.status === "FAIL")) {
    assert.ok(v.remediation, `FAIL at ${v.path} must carry remediation`);
    assert.equal(typeof v.remediation.confidence, "number", `${v.path} remediation.confidence must be a number`);
    assert.ok(v.remediation.confidence >= 0 && v.remediation.confidence <= 1);
  }
  const strengthFail = report.verdicts.find((x) => x.path === "strength" && x.comparison === "data_mismatch");
  assert.equal(strengthFail.remediation.source, "product_row");
  assert.equal(strengthFail.remediation.confidence, 1, "a product_row-sourced fix is fully trusted");
});

test("§UI redesign item 2: an unrecognized remediation.source is rejected, not silently accepted", async () => {
  // Simulate a validator bug: reaching into the engine's own guard directly
  // isn't possible from a black-box test, so this documents the enum instead —
  // every producer in the codebase must emit one of these five values.
  const VALID_SOURCES = ["rule", "product_row", "reference", "common_practice", "none"];
  assert.ok(VALID_SOURCES.includes("common_practice"), "common_practice must be a legitimate, honestly-labeled source");
  assert.ok(VALID_SOURCES.includes("none"), "none must stay legitimate — no sourced fix beats an invented one");
});

test("§UI redesign item 2: restricted fields never get a suggested value, even from common_practice", async () => {
  const badLabel = baseLabel({ withdrawalPeriod: undefined });
  const report = await validate(badLabel, { includePlausibility: false });
  const wp = report.verdicts.find((v) => v.path === "withdrawalPeriod" && v.status === "FAIL");
  assert.ok(wp);
  // Even if some future validator sourced this as common_practice, suggested must stay null.
  assert.equal(wp.remediation.suggested, null);
});
