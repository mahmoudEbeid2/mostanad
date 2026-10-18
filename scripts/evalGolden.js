import { BYPASS } from "../tests/testBypass.js";
// scripts/evalGolden.js — Phase 0.5 (§14.3). Runs every golden/ case through the
// live generation pipeline (POST /reference-labels/generate-text-ai), scores the
// result field by field against golden/<case>/expected.json, persists a
// GoldenEvalRun, and enforces CLAUDE.md invariant #11: a regression > 2% on ANY
// field blocks the change (exits non-zero).
//
// Requires the server AND labelGeneratorWorker.js already running — same
// convention as tests/*.test.js, this script doesn't start them for you.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../src/lib/prisma.js";
import { compareField } from "./goldenComparator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, "..", "golden");
const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000/api/v1";
const REGRESSION_THRESHOLD_PERCENT = 2;

const colors = { green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);

const FIELDS = ["productName", "feedClassification", "ingredients", "analysis", "aimOfUse", "targetAnimalSpecies", "directionOfUse", "storage", "netWeight", "usageDeclaration"];

// ── Pipeline execution ──────────────────────────────────────────────────────

async function ensureSandboxCompany() {
  const username = "golden_set_eval_co";
  let company = await prisma.company.findUnique({ where: { username } });
  if (!company) {
    company = await prisma.company.create({
      data: { name: "Golden Set Eval Co", username, password: "not-a-real-account", email: "golden-set@eval.local" },
    });
  }
  return company;
}

async function runCase(caseDir, companyId) {
  const input = JSON.parse(fs.readFileSync(path.join(caseDir, "input.json"), "utf-8"));
  const expected = JSON.parse(fs.readFileSync(path.join(caseDir, "expected.json"), "utf-8"));
  const tolerances = fs.existsSync(path.join(caseDir, "tolerances.json"))
    ? JSON.parse(fs.readFileSync(path.join(caseDir, "tolerances.json"), "utf-8"))
    : {};

  const submitRes = await fetch(`${BASE_URL}/reference-labels/generate-text-ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-bypass": BYPASS },
    body: JSON.stringify({ ...input, companyId }),
  });
  const submitData = await submitRes.json();
  if (submitRes.status !== 202 || !submitData?.data?.taskId) {
    return { error: `Submission failed: ${submitRes.status} ${JSON.stringify(submitData)}` };
  }

  const taskId = submitData.data.taskId;
  let task = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${BASE_URL}/background-tasks/${taskId}`, { headers: { "x-test-bypass": BYPASS } });
    const pollData = await pollRes.json();
    task = pollData?.data;
    if (task && (task.status === "completed" || task.status === "failed")) break;
  }

  if (!task || task.status !== "completed") {
    return { error: `Generation did not complete: status=${task?.status}, error=${task?.error}` };
  }

  const actualLabel = task.result?.label || task.result; // Phase 1 wraps as {taskId,labelId,label}
  const fieldResults = {};
  for (const field of FIELDS) {
    fieldResults[field] = compareField(field, expected[field], actualLabel?.[field], tolerances[field] || {});
  }
  return { fieldResults, modelId: task.result?.generationMeta?.modelId || null };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log("\n" + "=".repeat(60), "cyan");
  log("  GOLDEN SET EVALUATION (Phase 0.5, §14.3)", "bold");
  log("=".repeat(60) + "\n", "cyan");

  const caseDirs = fs.readdirSync(GOLDEN_DIR)
    .filter((f) => fs.statSync(path.join(GOLDEN_DIR, f)).isDirectory())
    .map((f) => path.join(GOLDEN_DIR, f));

  if (caseDirs.length === 0) {
    log("No case directories found under golden/ — nothing to evaluate.", "red");
    process.exit(1);
  }

  const company = await ensureSandboxCompany();
  log(`Using sandbox company: ${company.id}\n`, "cyan");

  const tally = {};
  for (const f of FIELDS) tally[f] = { exact: 0, partial: 0, wrong: 0, notApplicable: 0 };
  const failedCaseIds = [];
  let modelId = null;

  for (const dir of caseDirs) {
    const caseName = path.basename(dir);
    log(`Running: ${caseName}...`, "cyan");
    const result = await runCase(dir, company.id);

    if (result.error) {
      log(`  ERRORED: ${result.error}`, "red");
      failedCaseIds.push(caseName);
      for (const f of FIELDS) tally[f].wrong++; // an errored case scores as wrong on every field, not silently excluded
      continue;
    }

    modelId = modelId || result.modelId;
    for (const f of FIELDS) {
      const outcome = result.fieldResults[f];
      tally[f][outcome]++;
      const icon = { exact: "✅", partial: "⚠️", wrong: "❌", notApplicable: "➖" }[outcome];
      log(`  ${icon} ${f}: ${outcome}`);
    }
  }

  // ── Scoring ────────────────────────────────────────────────────────────────
  const fieldAccuracy = {};
  const accuracyPercents = [];
  for (const f of FIELDS) {
    const { exact, partial, wrong, notApplicable } = tally[f];
    const scored = exact + partial + wrong; // notApplicable excluded from the denominator
    const accuracyPercent = scored > 0 ? ((exact + 0.5 * partial) / scored) * 100 : null;
    fieldAccuracy[f] = { exact, partial, wrong, notApplicable, accuracyPercent };
    if (accuracyPercent !== null) accuracyPercents.push(accuracyPercent);
  }
  const overallAccuracy = accuracyPercents.length > 0
    ? accuracyPercents.reduce((a, b) => a + b, 0) / accuracyPercents.length
    : 0;

  const previousRun = await prisma.goldenEvalRun.findFirst({ orderBy: { runAt: "desc" } });
  const baselineAccuracy = previousRun?.overallAccuracy ?? null;

  let regressed = false;
  if (previousRun) {
    for (const f of FIELDS) {
      const prevPct = previousRun.fieldAccuracy?.[f]?.accuracyPercent;
      const currPct = fieldAccuracy[f].accuracyPercent;
      if (prevPct !== null && prevPct !== undefined && currPct !== null && (prevPct - currPct) > REGRESSION_THRESHOLD_PERCENT) {
        log(`\nREGRESSION on "${f}": ${prevPct.toFixed(1)}% -> ${currPct.toFixed(1)}%`, "red");
        regressed = true;
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  log("\n" + "-".repeat(70), "cyan");
  log("  FIELD                       EXACT  PARTIAL  WRONG   N/A   ACCURACY", "bold");
  log("-".repeat(70), "cyan");
  for (const f of FIELDS) {
    const a = fieldAccuracy[f];
    const pctStr = a.accuracyPercent === null ? "  n/a " : `${a.accuracyPercent.toFixed(1)}%`;
    const flag = a.accuracyPercent !== null && a.accuracyPercent < 70 ? " 🔴" : a.accuracyPercent !== null && a.accuracyPercent < 90 ? " ⚠️" : "";
    log(`  ${f.padEnd(26)} ${String(a.exact).padStart(5)}  ${String(a.partial).padStart(7)}  ${String(a.wrong).padStart(5)}  ${String(a.notApplicable).padStart(4)}   ${pctStr}${flag}`);
  }
  log("-".repeat(70), "cyan");
  const deltaStr = baselineAccuracy !== null
    ? `${overallAccuracy >= baselineAccuracy ? "+" : ""}${(overallAccuracy - baselineAccuracy).toFixed(1)} ${overallAccuracy >= baselineAccuracy ? "✅" : "🔻"}`
    : "(first run — this becomes the baseline)";
  log(`\n  Overall accuracy: ${overallAccuracy.toFixed(1)}%    Baseline: ${baselineAccuracy !== null ? baselineAccuracy.toFixed(1) + "%" : "n/a"}    Delta: ${deltaStr}`, "bold");
  if (failedCaseIds.length > 0) log(`  Cases that errored outright (not just scored low): ${failedCaseIds.join(", ")}`, "red");

  const blockedDeploy = regressed;

  await prisma.goldenEvalRun.create({
    data: {
      engineVersion: "label-validation-engine@1.0.0",
      modelId,
      promptHash: null, // populated once contextBuilder (Phase 4) computes one
      fieldAccuracy,
      overallAccuracy,
      baselineAccuracy,
      regressed,
      blockedDeploy,
      caseCount: caseDirs.length,
      failedCaseIds,
    },
  });

  log(`\n${blockedDeploy ? "🔴 BLOCKED — a field regressed more than 2%." : "✅ No blocking regression."}\n`, blockedDeploy ? "red" : "green");
  process.exit(blockedDeploy ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error running golden set evaluation:", err);
  process.exit(1);
});
