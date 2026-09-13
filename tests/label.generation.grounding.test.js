// Phase 4's deterministic logic: similarity scoring (§8.4), the target-species
// reconciliation (ported from the pre-Phase-4 worker, still code-computed per
// Invariant #2), and the grounding-policy hard backstop (Invariant #5 / §8.2's
// absolute exclusions) that runs on generated output regardless of what the
// model actually produced. No AI call needed for any of this.
import { scoreReference, tierFor, rankReferences } from "../src/services/label/retrieval/similarity.js";
import { classifyNeverGuessFields, resolveTargetAnimalsSource } from "../src/services/label/generation/labelGenerator.js";

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
// resolveTargetAnimalsSource is async (Tier 5 falls through to a cited
// lookup before "inferred") — no active ingredients in these profiles means
// the Tier 5 branch is skipped entirely, so these stay synchronous in effect.
const confirmedProfile = { confirmedFacts: { targetSpecies: ["Cattle", "Sheep"] } };
assert("Confirmed facts (Product row or user hint) always win -> source 'confirmed'", (await resolveTargetAnimalsSource(confirmedProfile, [])).source === "confirmed");
assert("Confirmed list matches exactly what was confirmed", JSON.stringify((await resolveTargetAnimalsSource(confirmedProfile, [])).list) === JSON.stringify(["Cattle", "Sheep"]));

const noConfirmedProfile = { confirmedFacts: {}, activeIngredients: [] };
const matchedRefs = [{ tier: "exact_combo", reference: { extractedData: { target_animal_species: ["Poultry", "poultry"] } } }];
const refResult = await resolveTargetAnimalsSource(noConfirmedProfile, matchedRefs);
assert("No confirmed facts, exact_combo reference exists -> source 'reference'", refResult.source === "reference");
assert("Reference species union de-duplicates case-insensitively", refResult.list.length === 1);

const noMatchResult = await resolveTargetAnimalsSource(noConfirmedProfile, []);
assert("No confirmed facts, no matching reference -> source 'inferred', model must supply", noMatchResult.source === "inferred" && noMatchResult.list === null);

// ── Grounding policy classification (amended Invariant #5) ─────────────────
// "Every field is generated — none render blank" (product owner decision,
// CLAUDE.md). classifyNeverGuessFields no longer nulls anything — labelData
// keeps whatever the model wrote; it only classifies WHY each never-guess
// field should be trusted (grounded: tier 1/4/5) vs. must be flagged as a
// Tier 6 estimate (estimated[]).
log("\n-- Grounding policy classification (amended Invariant #5) --", "cyan");

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
const { estimated: allEstimated } = classifyNeverGuessFields(ungroundedLabel, { profile: emptyProfile, groundedNeverGuessFacts: {} });

assert("Model's withdrawalPeriod value is untouched, not nulled", ungroundedLabel.withdrawalPeriod !== null);
assert("Model's strength value is untouched, not nulled", ungroundedLabel.strength !== null);
assert("Model's registrationNumber value is untouched, not nulled", ungroundedLabel.registrationNumber !== null);
assert("Model's batchNo value is untouched, not nulled", ungroundedLabel.batchNo !== null);
assert("Model's expiryDate value is untouched, not nulled", ungroundedLabel.expiryDate !== null);
assert("Ungrounded ingredient amount is kept as the model wrote it, not forced to 'q.s.'", ungroundedLabel.activeIngredients[0].amount === "999 mg");
assert("Everything ungrounded is classified as estimated (for estimatedFields / audit trail / NEEDS_REVIEW)", allEstimated.length === 7); // 6 scalars + 1 ingredient amount

const groundedLabel = {
  withdrawalPeriod: { translations: { en: "14 days" }, primary: "en" },
  strength: { translations: { en: "100 mg" }, primary: "en" },
  registrationNumber: "REG-12345",
  batchNo: "LOT1",
  expiryDate: "2028-01-01",
  activeIngredients: [{ amount: "100 g" }],
  estimatedFields: [],
};
const groundedProfile = { withdrawalPeriod: "14 days", strength: "100 mg", registrationNumber: "REG-12345", activeIngredients: [{ amount: "100 g" }], formulationText: "Amoxicillin Trihydrate 100 g per kg" };
const { estimated: noneEstimated, grounded } = classifyNeverGuessFields(groundedLabel, { profile: groundedProfile, groundedNeverGuessFacts: {} });
assert("A value backed by the Product row profile is classified grounded, tier 1", grounded.withdrawalPeriod?.tier === 1 && grounded.strength?.tier === 1 && grounded.registrationNumber?.tier === 1);
assert("An ingredient amount present in formulationText is classified grounded, not estimated", grounded["activeIngredients[0].amount"] !== undefined);
assert("batchNo/expiryDate/shelfLifeAfterOpening have no profile/ladder source, so they're still estimated even on an otherwise-grounded label", noneEstimated.includes("batchNo") && noneEstimated.includes("expiryDate") && noneEstimated.includes("shelfLifeAfterOpening"));
assert("Only the genuinely ungroundable fields (batchNo, expiryDate, shelfLifeAfterOpening) are estimated here", noneEstimated.length === 3);

const referenceGroundedLabel = { withdrawalPeriod: { translations: { en: "10 days" }, primary: "en" }, strength: null, registrationNumber: null, batchNo: null, expiryDate: null, activeIngredients: [], estimatedFields: [] };
const tier4Facts = { withdrawalPeriod: { tier: 4, provenance: "reference", sourceRef: { kind: "reference_label", ids: ["ref-1"] }, citation: null, sourceUrl: null } };
const { estimated: tier4Estimated, grounded: tier4Grounded } = classifyNeverGuessFields(referenceGroundedLabel, { profile: emptyProfile, groundedNeverGuessFacts: tier4Facts });
assert("A Tier 4 (matched reference, via the field ladder) justifies withdrawalPeriod without a Product row value", tier4Grounded.withdrawalPeriod?.tier === 4);
assert("Tier 4 justification isn't in the estimated list for that field", !tier4Estimated.includes("withdrawalPeriod"));

log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
process.exit(failed > 0 ? 1 : 0);
