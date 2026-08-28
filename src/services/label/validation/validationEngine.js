import * as schemaValidator from "./schemaValidator.js";
import * as ruleValidator from "./ruleValidator.js";
import * as coherenceValidator from "./coherenceValidator.js";
import { resolveApplicability } from "../schema/fieldCatalog.js";

// Bump this whenever layers 1-4's logic changes in a way that could change a
// verdict for the same input — it's part of what "determinism" (§10.3, T10) is
// measured against.
export const ENGINE_VERSION = "label-validation-engine@1.1.0"; // coherence gained checks 5/6 (units-vs-form, ingredient-total impossibility), moved in from plausibility (§14.5.7 correction)

const getPlain = (obj, path) => path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

const isEmptyValue = (value) => {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "object" && "translations" in value) {
    return !value.primary || Object.keys(value.translations || {}).length === 0;
  }
  return false;
};

// Layer 2 (§10.1) — applicability, resolved from fieldCatalog.js. Only touches
// paths the catalog knows about; every other path keeps schemaValidator's verdict.
function applyApplicabilityLayer(labelData, schemaVerdicts) {
  return schemaVerdicts.map((verdict) => {
    const resolved = resolveApplicability(verdict.path, labelData);
    if (!resolved) return verdict;

    if (!resolved.applies) {
      return { ...verdict, status: "NOT_APPLICABLE", presence: verdict.presence, layer: "applicability", ruleKey: null, message: null };
    }
    if (verdict.status === "FAIL") return verdict; // a real structural problem outranks "is it required"

    const value = getPlain(labelData, verdict.path);
    if (isEmptyValue(value)) {
      return {
        ...verdict,
        status: "FAIL",
        presence: "MISSING",
        severity: resolved.severity,
        layer: "applicability",
        ruleKey: `APPLICABILITY.${verdict.path.toUpperCase()}.REQUIRED`,
        message: resolved.reason || `"${verdict.path}" is required for this product/species.`,
      };
    }
    return verdict;
  });
}

/**
 * The one validation engine (§4.2) — same labelData + same rules always produces
 * the same verdicts (layers 1-4 are pure functions of their inputs; no AI, no
 * Date.now(), no randomness). Used by both labelGeneratorWorker's output and
 * labelExtractor's output, so "same product + same country = same verdict"
 * holds regardless of whether the label was generated here or uploaded.
 *
 * rules: RegulatoryRule[]-shaped array (empty until Phase 3 populates real ones
 * from an approved RegulatoryDocument — ruleValidator reports that gap as
 * UNVERIFIABLE rather than silently passing).
 */
export const validate = (labelData, { rules = [] } = {}) => {
  const schemaVerdicts = schemaValidator.run(labelData);
  const layer12Verdicts = applyApplicabilityLayer(labelData, schemaVerdicts);
  const ruleVerdicts = ruleValidator.run(labelData, rules);
  const coherenceVerdicts = coherenceValidator.run(labelData);

  const verdicts = [...layer12Verdicts, ...ruleVerdicts, ...coherenceVerdicts];

  const errorCount = verdicts.filter((v) => v.status === "FAIL").length;
  const warningCount = verdicts.filter((v) => v.status === "WARN").length;
  const passed = verdicts.every((v) => v.status !== "FAIL");

  return {
    passed,
    errorCount,
    warningCount,
    verdicts,
    coveragePercent: null, // populated once Phase 3's coverageAuditor exists
    engineVersion: ENGINE_VERSION,
    rulesetIds: rules.map((r) => r.id).filter(Boolean),
    aiAssisted: false, // layer 5 (semantic) is Phase 5 — nothing here calls a model
  };
};
