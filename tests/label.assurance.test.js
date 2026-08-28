// Phase 5's deterministic logic: risk scoring (§14.6), self-consistency
// agreement thresholds (§14.2), and the auditor-vs-engine disagreement
// comparison (§14.1). None of this needs an AI call to verify.
import { riskScore, autonomyTierFor } from "../src/services/label/assurance/riskScorer.js";
import { AGREEMENT } from "../src/services/label/validation/selfConsistency.js";
import { compareVerdicts } from "../src/services/label/validation/adversarialAuditor.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

log("\n=== Phase 5: risk scoring, self-consistency, adversarial disagreement ===\n", "bold");

// ── riskScorer (§14.6) ───────────────────────────────────────────────────────
log("-- Risk scoring --", "cyan");
const lowRiskLabel = { targetAnimalSpecies: { list: ["Dog"] }, activeIngredients: [{ normalizedName: "vitamin c" }], productType: "supplement", estimatedFields: [] };
const lowScore = riskScore(lowRiskLabel, { verdicts: [] }, {});
assert("Companion animal + non-antimicrobial supplement -> low risk", lowScore === 0);
assert("Low risk -> auto_approve tier", autonomyTierFor(lowScore).tier === "auto_approve");

const highRiskLabel = { targetAnimalSpecies: { list: ["Cattle"] }, activeIngredients: [{ normalizedName: "amoxicillin trihydrate" }], productType: "veterinary_drug", estimatedFields: ["directionOfUse", "storage"] };
const highReport = { verdicts: [{ status: "UNVERIFIABLE" }] };
const highScore = riskScore(highRiskLabel, highReport, { document: { coveragePercent: 80 }, disagreementCount: 1 });
assert("Food-producing + antimicrobial + vet_drug + UNVERIFIABLE + estimates + low coverage + disagreement -> high risk", highScore >= 76);
assert("Very high risk -> dual_review tier (two independent reviewers)", autonomyTierFor(highScore).tier === "dual_review");

const midRiskLabel = { targetAnimalSpecies: { list: ["Poultry"] }, activeIngredients: [{ normalizedName: "vitamin e" }], productType: "feed_additive", estimatedFields: ["storage"] };
const midScore = riskScore(midRiskLabel, { verdicts: [] }, {});
assert("Food-producing but non-antimicrobial feed additive -> moderate, not extreme", midScore > 0 && midScore < 76);
assert("Risk score never exceeds 100 even with everything stacked", riskScore(highRiskLabel, highReport, { document: { coveragePercent: 50 }, disagreementCount: 5 }) <= 100);

// ── selfConsistency agreement thresholds (§14.2) ────────────────────────────
log("\n-- Self-consistency agreement thresholds --", "cyan");
assert("Numeric: identical values agree", AGREEMENT.numeric(["10mg", "10mg", "10mg"]));
assert("Numeric: within 5% spread agrees", AGREEMENT.numeric(["100", "102", "104"]));
assert("Numeric: beyond 5% spread disagrees", !AGREEMENT.numeric(["100", "150", "90"]));
assert("Numeric: a non-numeric run counts as disagreement", !AGREEMENT.numeric(["100mg", "unclear", "105mg"]));

assert("Set: identical species sets agree", AGREEMENT.set([["Cattle", "Sheep"], ["Cattle", "Sheep"], ["cattle", "sheep"]]));
assert("Set: below 0.9 Jaccard disagrees", !AGREEMENT.set([["Cattle", "Sheep"], ["Cattle"], ["Poultry"]]));

assert("Categorical: identical values agree", AGREEMENT.categorical(["POM", "POM", "pom"]));
assert("Categorical: any difference disagrees", !AGREEMENT.categorical(["POM", "OTC", "POM"]));

// ── Adversarial disagreement comparison (§14.1) ─────────────────────────────
log("\n-- Auditor vs. engine disagreement detection --", "cyan");
const engineVerdicts = [
  { path: "withdrawalPeriod", status: "PASS" },
  { path: "aimOfUse", status: "FAIL" },
  { path: "storage", status: "PASS" },
];
const agreeingAuditor = [
  { path: "withdrawalPeriod", status: "PASS", reasoning: "Looks fine." },
  { path: "aimOfUse", status: "FAIL", reasoning: "Confirmed issue." },
  { path: "storage", status: "PASS", reasoning: "Fine." },
];
assert("No disagreements when engine and auditor fully agree", compareVerdicts(engineVerdicts, agreeingAuditor).length === 0);

const disagreeingAuditor = [
  { path: "withdrawalPeriod", status: "FAIL", reasoning: "Auditor thinks this is actually missing critical detail." },
  { path: "aimOfUse", status: "FAIL", reasoning: "Confirmed issue." },
  { path: "storage", status: "PASS", reasoning: "Fine." },
];
const disagreements = compareVerdicts(engineVerdicts, disagreeingAuditor);
assert("Exactly one disagreement detected (withdrawalPeriod: engine PASS vs auditor FAIL)", disagreements.length === 1 && disagreements[0].fieldPath === "withdrawalPeriod");
assert("Disagreement carries both verdicts and the auditor's reasoning", !!disagreements[0].auditorReasoning && !!disagreements[0].deterministicVerdict && !!disagreements[0].auditorVerdict);

const partialAuditor = [{ path: "aimOfUse", status: "FAIL", reasoning: "Confirmed." }]; // auditor didn't review the other two fields
assert("Fields the auditor didn't review are not counted as disagreements", compareVerdicts(engineVerdicts, partialAuditor).length === 0);

log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
process.exit(failed > 0 ? 1 : 0);
