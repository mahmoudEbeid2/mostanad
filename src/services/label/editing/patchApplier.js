import { applyPatch, validatePatchShape, readPath } from "./patchProtocol.js";
import { validate } from "../validation/validationEngine.js";

/**
 * §11.4 guards #3-4: dry-run first, then conflict detection. Never mutates
 * anything — pure function of (currentLabelData, currentReport, patch, rules).
 * Returns one of:
 *   { status: "invalid", errors: [{path, reason, previousValue}] } — shape/path
 *     rejected. This is an OUTCOME, not a transport failure — the caller
 *     (generatedLabelService's chat()/applyDirectPatch()) returns it to the
 *     client as a normal 200 { status: "refused" }, never an HTTP error.
 *   { status: "conflict", candidateLabelData, wouldViolate: [...] } — new FAILs introduced
 *   { status: "clean", candidateLabelData, report }     — safe to apply
 */
export async function dryRunPatch(currentLabelData, currentReport, patch, { rules = [] } = {}) {
  const withPreviousValue = (errors) => errors.map((e) => ({ ...e, previousValue: readPath(currentLabelData, e.path) }));

  const shapeCheck = validatePatchShape(patch);
  if (!shapeCheck.ok) return { status: "invalid", errors: withPreviousValue(shapeCheck.errors) };

  let candidateLabelData;
  try {
    candidateLabelData = applyPatch(currentLabelData, patch.changes);
  } catch (err) {
    return { status: "invalid", errors: withPreviousValue([{ path: err.path || null, reason: err.message }]) };
  }

  // includePlausibility: false — this only compares FAIL sets (see below),
  // and plausibility can structurally never emit FAIL, so it can never change
  // the conflict decision. Running it here would just be 4 extra Gemini calls
  // on every chat-edit attempt for zero effect on the outcome.
  const newReport = await validate(candidateLabelData, { rules, includePlausibility: false });

  // A "new" FAIL is one that wasn't already a FAIL on the same path before
  // this patch — an edit that doesn't make anything WORSE is never a conflict,
  // even if the label already had pre-existing failures elsewhere.
  const previousFailPaths = new Set((currentReport?.verdicts || []).filter((v) => v.status === "FAIL").map((v) => v.path));
  const newFailures = newReport.verdicts.filter((v) => v.status === "FAIL" && !previousFailPaths.has(v.path));

  if (newFailures.length > 0) {
    return {
      status: "conflict",
      candidateLabelData,
      report: newReport,
      wouldViolate: newFailures.map((v) => ({ ruleKey: v.ruleKey || null, message: v.message || null, citation: v.citation || null, path: v.path || null })),
      options: ["cancel", ...newFailures.map((v) => `apply_and_fix:${v.path}`), "apply_anyway_with_override"],
    };
  }

  return { status: "clean", candidateLabelData, report: newReport };
}
