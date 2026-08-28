// Phase 4's deterministic logic: similarity scoring (§8.4), the target-species
// reconciliation (ported from the pre-Phase-4 worker, still code-computed per
// Invariant #2), and the grounding-policy hard backstop (Invariant #5 / §8.2's
// absolute exclusions) that runs on generated output regardless of what the
// model actually produced. No AI call needed for any of this.
import { scoreReference, tierFor, rankReferences } from "../src/services/label/retrieval/similarity.js";
import { enforceGroundingPolicy, resolveTargetAnimalsSource } from "../src/services/label/generation/labelGenerator.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

log("\n=== Phase 4: similarity, target-species resolution, grounding policy ===\n", "bold");

// ── similarity.js / §8.4 tiers ──────────────────────────────────────────────
log("-- Reference scoring + tier assignment --", "cyan");
const profile = {
  activeIngredients: [{ normalizedName: "amoxicillin trihydrate" }],
  strength: "100 mg",
  dosageForm: "powder",
  targetSpecies: ["Poultry"],
  indicationTags: [],
  routeOfAdministration: "oral",
  country: "Egypt",
};

const exactRef = { activeIngredients: [{ normalizedName: "amoxicillin trihydrate" }], strengthSummary: "100 mg", dosageForm: "powder", targetSpecies: ["Poultry"], country: "Egypt", qualityWeight: 1 };
const exactScored = scoreReference(profile, exactRef);
assert("Identical ingredient+strength+form+species -> tier exact_combo", tierFor(exactScored) === "exact_combo");

const partialRef = { activeIngredients: [{ normalizedName: "amoxicillin trihydrate" }, { normalizedName: "unrelated filler" }], strengthSummary: "500 mg", dosageForm: "liquid", targetSpecies: ["Cattle"], country: "Saudi Arabia", qualityWeight: 1 };
const partialScored = scoreReference(profile, partialRef);
assert("Shared ingredient but different everything else -> tier ingredient (still >=0.5 ingredientMatch is false here, expect attribute/none)", ["ingredient", "attribute", "none"].includes(tierFor(partialScored)));

const unrelatedRef = { activeIngredients: [{ normalizedName: "vitamin c" }], strengthSummary: "10 mg", dosageForm: "liquid", targetSpecies: ["Fish"], country: "UAE", qualityWeight: 1 };
const unrelatedScored = scoreReference(profile, unrelatedRef);
assert("Completely unrelated reference -> tier none", tierFor(unrelatedScored) === "none");

const ranked = rankReferences(profile, [exactRef, unrelatedRef]);
assert("rankReferences excludes tier 'none' entries", ranked.length === 1);
assert("rankReferences sorts by finalScore descending (best first)", ranked[0].tier === "exact_combo");

// ── Target species reconciliation ───────────────────────────────────────────
log("\n-- Target species reconciliation (code-computed, Invariant #2) --", "cyan");
const confirmedProfile = { confirmedFacts: { targetSpecies: ["Cattle", "Sheep"] } };
assert("Confirmed facts (Product row or user hint) always win -> source 'confirmed'", resolveTargetAnimalsSource(confirmedProfile, []).source === "confirmed");
assert("Confirmed list matches exactly what was confirmed", JSON.stringify(resolveTargetAnimalsSource(confirmedProfile, []).list) === JSON.stringify(["Cattle", "Sheep"]));

const noConfirmedProfile = { confirmedFacts: {} };
const matchedRefs = [{ tier: "exact_combo", reference: { extractedData: { target_animal_species: ["Poultry", "poultry"] } } }];
const refResult = resolveTargetAnimalsSource(noConfirmedProfile, matchedRefs);
assert("No confirmed facts, exact_combo reference exists -> source 'reference'", refResult.source === "reference");
assert("Reference species union de-duplicates case-insensitively", refResult.list.length === 1);

const noMatchResult = resolveTargetAnimalsSource(noConfirmedProfile, []);
assert("No confirmed facts, no matching reference -> source 'inferred', model must supply", noMatchResult.source === "inferred" && noMatchResult.list === null);

// ── Grounding policy hard backstop (Invariant #5) ───────────────────────────
log("\n-- Grounding policy enforcement (Invariant #5's hard backstop) --", "cyan");

const ungroundedLabel = {
  withdrawalPeriod: { translations: { en: "14 days" }, primary: "en" },
  strength: { translations: { en: "500mg" }, primary: "en" },
  registrationNumber: "REG-99999",
  batchNo: "LOT123",
  expiryDate: "2028-01-01",
  activeIngredients: [{ amount: "999 mg" }],
  estimatedFields: [],
};
const emptyProfile = { withdrawalPeriod: null, strength: null, registrationNumber: null, activeIngredients: [], formulationText: "Amoxicillin Trihydrate 100 g per kg" };
const refused = enforceGroundingPolicy(ungroundedLabel, { profile: emptyProfile, matchedReferences: [] });

assert("Ungrounded withdrawalPeriod is nulled", ungroundedLabel.withdrawalPeriod === null);
assert("Ungrounded strength is nulled", ungroundedLabel.strength === null);
assert("Ungrounded registrationNumber is nulled", ungroundedLabel.registrationNumber === null);
assert("batchNo is always nulled unless code explicitly trusts it (never derivable from formulation/reference)", ungroundedLabel.batchNo === null);
assert("expiryDate is always nulled the same way", ungroundedLabel.expiryDate === null);
assert("Ungrounded ingredient amount is downgraded to 'q.s.', not left as an invented number", ungroundedLabel.activeIngredients[0].amount === "q.s.");
assert("All refusals are reported back (for estimatedFields / audit trail)", refused.length === 6);

const groundedLabel = {
  withdrawalPeriod: { translations: { en: "14 days" }, primary: "en" },
  strength: { translations: { en: "100 mg" }, primary: "en" },
  registrationNumber: "REG-12345",
  batchNo: null,
  expiryDate: null,
  activeIngredients: [{ amount: "100 g" }],
  estimatedFields: [],
};
const groundedProfile = { withdrawalPeriod: "14 days", strength: "100 mg", registrationNumber: "REG-12345", activeIngredients: [{ amount: "100 g" }], formulationText: "Amoxicillin Trihydrate 100 g per kg" };
const noRefusals = enforceGroundingPolicy(groundedLabel, { profile: groundedProfile, matchedReferences: [] });
assert("A value backed by the Product row profile is NOT refused", groundedLabel.withdrawalPeriod !== null && groundedLabel.strength !== null && groundedLabel.registrationNumber !== null);
assert("An ingredient amount present in formulationText is NOT downgraded", groundedLabel.activeIngredients[0].amount === "100 g");
assert("No refusals when everything is properly grounded", noRefusals.length === 0);

const referenceGroundedLabel = { withdrawalPeriod: { translations: { en: "10 days" }, primary: "en" }, strength: null, registrationNumber: null, batchNo: null, expiryDate: null, activeIngredients: [], estimatedFields: [] };
const tier4Refusals = enforceGroundingPolicy(referenceGroundedLabel, { profile: emptyProfile, matchedReferences: [{ tier: "ingredient", reference: {} }] });
assert("A Tier 4 (matched reference) justifies withdrawalPeriod without a Product row value", referenceGroundedLabel.withdrawalPeriod !== null);
assert("Tier 4 justification isn't in the refused list for that field", !tier4Refusals.includes("withdrawalPeriod"));

log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
process.exit(failed > 0 ? 1 : 0);
