// Phase 8: shadow mode's mechanism, proven against SYNTHETIC old/new
// implementations — not real generation. See PROGRESS.md's Phase 8 entry for
// why: this session replaced the generator in place through Phases 0-6 rather
// than keeping two versions running in parallel, so there's no real "old
// path" left to shadow the "new path" against for THIS migration. This test
// proves the reusable runShadow/checkShadowGates mechanism itself is correct,
// ready for the next migration that actually needs it.
import { prisma } from "../src/lib/prisma.js";
import { runShadow, checkShadowGates } from "../src/services/label/assurance/shadowRunner.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

const validLabel = {
  schemaVersion: "vet-label@2.0.0", productType: "supplement",
  productName: { translations: { en: "TestProduct" }, primary: "en" }, pharmaceuticalForm: null, strength: null,
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

async function run() {
  log("\n=== Phase 8: shadow mode mechanism (synthetic old/new) ===\n", "bold");

  // ── runShadow against two identical implementations ─────────────────────────
  log("-- runShadow: identical old/new -> no diff --", "cyan");
  const identicalOld = async () => ({ labelData: validLabel, rules: [], costUsd: 0.01 });
  const identicalNew = async () => ({ labelData: validLabel, rules: [], costUsd: 0.005 });
  const identicalComparison = await runShadow(identicalOld, identicalNew, {});
  assert("Identical labelData produces zero fieldsDiffered", identicalComparison.fieldsDiffered.length === 0);
  assert("Both PASS -> verdictDiffered is false", identicalComparison.verdictDiffered === false);
  assert("costDelta reflects the actual price difference", Math.abs(identicalComparison.costDelta - (-0.005)) < 0.0001);
  assert("A ShadowComparison row was actually persisted", !!identicalComparison.id);

  log("\n-- runShadow: a real difference is captured --", "cyan");
  const changedLabel = { ...validLabel, storage: { translations: { en: "Store below 25C" }, primary: "en" } };
  const oldFn = async () => ({ labelData: validLabel, rules: [] });
  const newFn = async () => ({ labelData: changedLabel, rules: [] });
  const diffComparison = await runShadow(oldFn, newFn, {});
  assert("A changed field is reported in fieldsDiffered", diffComparison.fieldsDiffered.includes("storage"));

  log("\n-- runShadow: a verdict-changing difference (PASS -> FAIL) --", "cyan");
  const brokenLabel = { ...validLabel, activeIngredients: [] }; // violates min(1) — schema layer FAILs
  const oldPassFn = async () => ({ labelData: validLabel, rules: [] });
  const newFailFn = async () => ({ labelData: brokenLabel, rules: [] });
  const verdictDiffComparison = await runShadow(oldPassFn, newFailFn, {});
  assert("A PASS -> FAIL change is flagged as verdictDiffered", verdictDiffComparison.verdictDiffered === true);

  // ── checkShadowGates (§14.5's four gates) ───────────────────────────────────
  log("\n-- checkShadowGates: the four promotion gates --", "cyan");
  const manyAgreeing = Array.from({ length: 100 }, () => ({ oldEngineResult: {}, newEngineResult: {}, verdictDiffered: false }));
  const allGatesPass = checkShadowGates({ comparisons: manyAgreeing, goldenAccuracy: 92, goldenBaseline: 90, p95LatencyMs: 4000, p95BudgetMs: 5000 });
  assert("Gate 1 (>=100 runs, no failures) passes with 100 clean runs", allGatesPass.gate1_noFailures);
  assert("Gate 2 (>=95% verdict agreement) passes with 100% agreement", allGatesPass.gate2_verdictAgreement);
  assert("Gate 3 (golden >= baseline) passes when accuracy improved", allGatesPass.gate3_goldenAtOrAboveBaseline);
  assert("Gate 4 (p95 within budget) passes when under budget", allGatesPass.gate4_latencyWithinBudget);
  assert("allPassed is true only when every gate passes", allGatesPass.allPassed === true);

  const tooFewRuns = checkShadowGates({ comparisons: manyAgreeing.slice(0, 50), goldenAccuracy: 92, goldenBaseline: 90, p95LatencyMs: 4000, p95BudgetMs: 5000 });
  assert("Gate 1 fails with fewer than 100 runs", !tooFewRuns.gate1_noFailures);
  assert("allPassed is false if even one gate fails", tooFewRuns.allPassed === false);

  const disagreeingRuns = [
    ...Array.from({ length: 90 }, () => ({ oldEngineResult: {}, newEngineResult: {}, verdictDiffered: false })),
    ...Array.from({ length: 10 }, () => ({ oldEngineResult: {}, newEngineResult: {}, verdictDiffered: true })),
  ];
  const lowAgreement = checkShadowGates({ comparisons: disagreeingRuns, goldenAccuracy: 92, goldenBaseline: 90, p95LatencyMs: 4000, p95BudgetMs: 5000 });
  assert("Gate 2 fails below 95% verdict agreement (90/100 = 90%)", !lowAgreement.gate2_verdictAgreement);

  const regressedGolden = checkShadowGates({ comparisons: manyAgreeing, goldenAccuracy: 85, goldenBaseline: 90, p95LatencyMs: 4000, p95BudgetMs: 5000 });
  assert("Gate 3 fails when golden-set accuracy regressed below baseline", !regressedGolden.gate3_goldenAtOrAboveBaseline);

  const overBudget = checkShadowGates({ comparisons: manyAgreeing, goldenAccuracy: 92, goldenBaseline: 90, p95LatencyMs: 8000, p95BudgetMs: 5000 });
  assert("Gate 4 fails when p95 latency exceeds budget", !overBudget.gate4_latencyWithinBudget);

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  await prisma.shadowComparison.deleteMany({ where: { id: { in: [identicalComparison.id, diffComparison.id, verdictDiffComparison.id] } } });

  log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
