import { prisma } from "../../../lib/prisma.js";
import { validate } from "../validation/validationEngine.js";

// §14.5. Generic by design: runs any "old" and "new" implementation of the
// same generation/validation step side by side and records the comparison.
//
// HONEST LIMITATION: this session did NOT keep the pre-Phase-4 ad-hoc
// generator running in parallel with the new schema-constrained one — Phases
// 0-6 replaced labelGeneratorWorker.js in place, the same way every other
// phase in this run did. There is no "old path" left to shadow the "new path"
// against for the migration this doc had in mind. This module is the real,
// reusable mechanism (tested against synthetic functions, see
// tests/label.shadow.test.js) — ready for the NEXT such migration (e.g. a
// future prompt rewrite, or the pgvector layer if it's ever justified), not a
// working demo of THIS migration, which already happened without it.

export async function runShadow(oldFn, newFn, input, { labelId = null } = {}) {
  const t0 = Date.now();
  const oldResult = await oldFn(input);
  const t1 = Date.now();
  const newResult = await newFn(input);
  const t2 = Date.now();

  const fieldsDiffered = diffTopLevelFields(oldResult.labelData, newResult.labelData);
  const oldReport = await validate(oldResult.labelData, { rules: oldResult.rules || [], includePlausibility: false });
  const newReport = await validate(newResult.labelData, { rules: newResult.rules || [], includePlausibility: false });
  const verdictDiffered = oldReport.passed !== newReport.passed;

  const comparison = await prisma.shadowComparison.create({
    data: {
      labelId,
      oldEngineResult: oldResult,
      newEngineResult: newResult,
      fieldsDiffered,
      verdictDiffered,
      latencyDeltaMs: (t2 - t1) - (t1 - t0),
      costDelta: (newResult.costUsd ?? 0) - (oldResult.costUsd ?? 0),
    },
  });

  return comparison;
}

function diffTopLevelFields(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

/**
 * §14.5's four gates. Pure — takes already-computed inputs so it's testable
 * without a live shadow run.
 */
export function checkShadowGates({ comparisons, goldenAccuracy, goldenBaseline, p95LatencyMs, p95BudgetMs }) {
  const gates = {
    gate1_noFailures: comparisons.length >= 100 && comparisons.every((c) => c.oldEngineResult && c.newEngineResult),
    gate2_verdictAgreement: comparisons.length > 0 ? comparisons.filter((c) => !c.verdictDiffered).length / comparisons.length >= 0.95 : false,
    gate3_goldenAtOrAboveBaseline: goldenAccuracy >= goldenBaseline,
    gate4_latencyWithinBudget: p95LatencyMs <= p95BudgetMs,
  };
  return { ...gates, allPassed: Object.values(gates).every(Boolean) };
}
