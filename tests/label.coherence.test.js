// §10.1 layer 4 (coherence) — including checks 5 & 6, moved in from
// plausibility (§14.5.7 correction): units-vs-form and ingredient-total
// impossibility are self-contained (everything needed is on the label), so
// unlike plausibility this layer can emit FAIL.
import * as coherenceValidator from "../src/services/label/validation/coherenceValidator.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

const ing = (name, amount, unit) => ({ translations: { en: name }, primary: "en", amount, unit, normalizedName: name.toLowerCase() });
const lt = (text) => ({ translations: { en: text }, primary: "en" });
const findVerdict = (verdicts, path) => verdicts.filter((v) => v.path === path);

log("\n=== §10.1 Layer 4: coherence (incl. checks 5 & 6, moved from plausibility) ===\n", "bold");

// ── Check 5: units vs. pharmaceutical form ──────────────────────────────────
log("-- Units vs. pharmaceutical form --", "cyan");
{
  const liquidLabelWithPowderUnits = {
    pharmaceuticalForm: lt("Oral Solution"),
    activeIngredients: [ing("Amoxicillin", "500", "mg/g")], // solid unit on a liquid form
  };
  const verdicts = coherenceValidator.run(liquidLabelWithPowderUnits);
  const v = findVerdict(verdicts, "pharmaceuticalForm")[0];
  assert("Liquid form + solid-unit ingredient -> FAIL (deterministic contradiction)", v.status === "FAIL", v);
  assert("FAIL verdict carries layer=coherence", v.layer === "coherence");
}
{
  const consistentLiquid = {
    pharmaceuticalForm: lt("Oral Solution"),
    activeIngredients: [ing("Amoxicillin", "50", "mg/ml")],
  };
  const v = findVerdict(coherenceValidator.run(consistentLiquid), "pharmaceuticalForm")[0];
  assert("Liquid form + liquid-unit ingredient -> PASS", v.status === "PASS", v);
}
{
  const solidWithLiquidUnits = {
    analysis: { basis: "per 1 kg", items: [] },
    activeIngredients: [ing("Vitamin E", "10", "IU/ml")], // liquid unit on a solid (basis) form
  };
  const v = findVerdict(coherenceValidator.run(solidWithLiquidUnits), "pharmaceuticalForm")[0];
  assert("analysis.basis='per 1 kg' + liquid-unit ingredient -> FAIL", v.status === "FAIL", v);
}
{
  const unknownForm = { activeIngredients: [ing("Vitamin E", "10", "mg/g")] };
  const v = findVerdict(coherenceValidator.run(unknownForm), "pharmaceuticalForm")[0];
  assert("No classifiable form -> NOT_APPLICABLE, not PASS", v.status === "NOT_APPLICABLE", v);
}

// ── Check 6: ingredient totals not mathematically impossible ───────────────
log("\n-- Ingredient total impossibility --", "cyan");
{
  const over100Percent = {
    activeIngredients: [ing("A", "60", "%w/w"), ing("B", "55", "%w/w")],
  };
  const v = findVerdict(coherenceValidator.run(over100Percent), "activeIngredients")[0];
  assert("60% + 55% = 115% -> FAIL (mathematically impossible)", v.status === "FAIL", v);
}
{
  const over1000GramsPerKg = {
    activeIngredients: [ing("A", "600", "g/kg"), ing("B", "500", "g/kg")],
  };
  const v = findVerdict(coherenceValidator.run(over1000GramsPerKg), "activeIngredients")[0];
  assert("600 g/kg + 500 g/kg = 1100 g/kg -> FAIL", v.status === "FAIL", v);
}
{
  const mgPerGEquivalence = {
    activeIngredients: [ing("A", "1100", "mg/g")], // 1100 mg/g == 1100 g/kg, over the ceiling alone
  };
  const v = findVerdict(coherenceValidator.run(mgPerGEquivalence), "activeIngredients")[0];
  assert("mg/g is treated as numerically equal to g/kg (1100 mg/g -> FAIL)", v.status === "FAIL", v);
}
{
  const withinLimits = {
    activeIngredients: [ing("A", "10", "%w/w"), ing("B", "5", "%w/w"), ing("C", "200", "g/kg")],
  };
  const v = findVerdict(coherenceValidator.run(withinLimits), "activeIngredients")[0];
  assert("10% + 5% (separate family from 200 g/kg) -> PASS", v.status === "PASS", v);
}
{
  const qsExcluded = {
    activeIngredients: [ing("A", "q.s.", "%w/w"), ing("B", "40", "%w/w")],
  };
  const v = findVerdict(coherenceValidator.run(qsExcluded), "activeIngredients")[0];
  assert('"q.s." amounts are excluded from the sum, not treated as 0% wrongly triggering FAIL', v.status === "PASS", v);
}
{
  const unparseableUnitExcluded = {
    activeIngredients: [ing("A", "50", "mg/ml"), ing("B", "40", "%w/w")], // mg/ml not summed into either family
  };
  const v = findVerdict(coherenceValidator.run(unparseableUnitExcluded), "activeIngredients")[0];
  assert("Concentration units (mg/ml) are excluded from the sum, only %w/w counted -> PASS", v.status === "PASS", v);
}

// ── Regression: pre-existing 4 checks still work ────────────────────────────
log("\n-- Pre-existing checks (regression) --", "cyan");
{
  const dupSpecies = { targetAnimalSpecies: { list: ["Cattle", "cattle "] } };
  const v = findVerdict(coherenceValidator.run(dupSpecies), "targetAnimalSpecies.list")[0];
  assert("Duplicate species (case/whitespace-insensitive) -> WARN", v.status === "WARN", v);
}
{
  const badPrimary = { productName: { translations: { en: "X" }, primary: "ar" } };
  const v = findVerdict(coherenceValidator.run(badPrimary), "_localized_text")[0];
  assert("primary not in translations -> FAIL", v.status === "FAIL", v);
}
{
  const bareX = { aimOfUse: lt("x") };
  const v = findVerdict(coherenceValidator.run(bareX), "_placeholder_x")[0];
  assert('Bare "x" placeholder -> FAIL', v.status === "FAIL", v);
}

log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
process.exit(failed > 0 ? 1 : 0);
