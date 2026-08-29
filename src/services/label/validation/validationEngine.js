import * as schemaValidator from "./schemaValidator.js";
import * as ruleValidator from "./ruleValidator.js";
import * as coherenceValidator from "./coherenceValidator.js";
import * as plausibilityValidator from "./plausibilityValidator.js";
import { resolveApplicability } from "../schema/fieldCatalog.js";

// Bump this whenever layers 1-4's logic changes in a way that could change a
// verdict for the same input — it's part of what "determinism" (§10.3, T10) is
// measured against.
export const ENGINE_VERSION = "label-validation-engine@1.4.0"; // §UI redesign: whySource/triggeredBy/observed/expected, remediation.confidence

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

const extractTextString = (val) => {
  if (!val) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "object" && val.translations) {
    return (val.translations[val.primary] || Object.values(val.translations)[0] || "").trim();
  }
  return String(val).trim();
};

// §14.5.2 item 3: a raw string-equality check flags a full stop ("None" vs
// "None.") or a spacing difference ("5 mg" vs "5mg") as a must-fix regulated
// finding. Normalise first — a difference that survives normalisation is a
// real finding; punctuation/spacing/case is not.
const normalizeForCompare = (s) =>
  s.trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/g, "").toLowerCase();

const NUMBER_UNIT_RE = /^(-?\d+(?:\.\d+)?)\s*([a-z/%µμ]*)$/;

const parseNumberUnit = (s) => {
  const m = normalizeForCompare(s).match(NUMBER_UNIT_RE);
  return m ? { value: parseFloat(m[1]), unit: m[2] } : null;
};

// True when two label-facing strings mean the same thing: same text after
// normalisation, or the same number+unit regardless of spacing/decimal form
// (5 mg == 5mg == 5.0 mg).
const valuesMatch = (a, b) => {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return true;
  const pa = parseNumberUnit(a);
  const pb = parseNumberUnit(b);
  return !!pa && !!pb && pa.unit === pb.unit && Math.abs(pa.value - pb.value) < 1e-9;
};

// FieldVerdict.whySource (§UI redesign item 1): what the user is being told
// to TRUST — deliberately not the same axis as `comparison`. A regulation
// stops a shipment; a disagreement with the caller's own catalogue might mean
// the catalogue is wrong, not the label. Derived from `layer`, not
// `comparison`: applicability/fieldCatalog verdicts keep comparison:"regulatory"
// for backward compatibility, but they're an internal completeness heuristic
// (see fieldCatalog.js's own header), not a sourced country regulation —
// labeling them "regulation" would imply a citable authority that isn't there.
const WHY_SOURCE_BY_LAYER = {
  regulatory_rule: "regulation",
  semantic: "regulation",
  applicability: "structure",
  product_match: "your_data",
  extraction: "your_data",
  schema: "structure",
  coherence: "structure",
  plausibility: "plausibility",
};

// FieldVerdict.remediation.confidence (§UI redesign item 2): how much to
// trust the suggested fix, derived from where it came from. "common_practice"
// must read as low-confidence and unsourced — never let it masquerade as a
// verified fix. Also doubles as an enum guard: an unrecognized source is a
// bug in whichever validator produced it, not something to silently accept.
const REMEDIATION_CONFIDENCE_BY_SOURCE = {
  rule: 1,
  product_row: 1,
  reference: 0.6,
  common_practice: 0.3,
  none: 0,
};

const RESTRICTED_SUGGESTION_FIELDS = new Set([
  "withdrawalPeriod",
  "strength",
  "registrationNumber",
  "activeIngredients",
  "activeIngredients[0].amount",
]);

// Layer 2 (§10.1) — applicability, resolved from fieldCatalog.js. Only touches
// paths the catalog knows about; every other path keeps schemaValidator's verdict.
function applyApplicabilityLayer(labelData, schemaVerdicts) {
  return schemaVerdicts.map((verdict) => {
    const resolved = resolveApplicability(verdict.path, labelData);
    if (!resolved) return verdict;

    if (!resolved.applies) {
      return {
        ...verdict,
        status: "NOT_APPLICABLE",
        presence: verdict.presence,
        layer: "applicability",
        comparison: "regulatory",
        ruleKey: null,
        message: null,
        triggeredBy: null,
        remediation: null,
      };
    }
    if (verdict.status === "FAIL") return { ...verdict, triggeredBy: resolved.triggeredBy }; // a real structural problem outranks "is it required"

    const value = getPlain(labelData, verdict.path);
    if (isEmptyValue(value)) {
      return {
        ...verdict,
        status: "FAIL",
        presence: "MISSING",
        severity: resolved.severity,
        layer: "applicability",
        comparison: "regulatory",
        ruleKey: `APPLICABILITY.${verdict.path.toUpperCase()}.REQUIRED`,
        message: resolved.reason || `"${verdict.path}" is required for this product/species.`,
        triggeredBy: resolved.triggeredBy,
        observed: null,
        expected: null,
        remediation: {
          action: "add",
          suggested: null,
          source: "rule",
          sourceRef: { ruleKey: `APPLICABILITY.${verdict.path.toUpperCase()}.REQUIRED` },
        },
      };
    }
    return { ...verdict, triggeredBy: resolved.triggeredBy };
  });
}

// §14.5.7 / Invariant #7: when ingredient-name extraction fails during
// generation, reference-label matching never gets attempted for this label —
// silently continuing without recording that fact would produce a label that
// LOOKS grounded (matchTier/provenance just quietly fall through to "none"/
// "inferred") when actually the grounding step was never even tried. This
// turns that gap into a real, visible verdict instead: UNVERIFIABLE (never
// coerced to PASS, Invariant #6) on the fields whose provenance depends on a
// reference match.
function buildGroundingFailureVerdict() {
  return {
    path: "_referenceGrounding",
    label: { en: "Reference grounding", ar: "التأريض بالمرجع" },
    status: "UNVERIFIABLE",
    presence: "PRESENT",
    severity: "error",
    layer: "applicability",
    comparison: "regulatory",
    ruleKey: null,
    message:
      "Ingredient-name extraction failed during generation, so reference-label matching never ran. targetAnimalSpecies, aimOfUse, directionOfUse, and storage could not be grounded against an approved reference — treat their current values as the model's own estimate, not a matched reference.",
    citation: null,
    sourceDocumentId: null,
    autoFixable: false,
    suggestion: null,
    remediation: null,
  };
}

/**
 * §14.5.1 & §14.5.2: 3-way comparison against confirmed product record in database.
 * When product is supplied, compare product facts with label data.
 * Emits verdicts with comparison: "data_mismatch" and layer: "product_match".
 */
function checkProductDataMatch(labelData, product, unconfirmedPaths = new Set()) {
  if (!product) return [];
  const verdicts = [];

  const checkField = (path, labelName, labelVal, productVal) => {
    if (unconfirmedPaths.has(path)) return; // §14.5.3: low confidence fields are not compared
    const labelStr = extractTextString(labelVal);
    const prodStr = extractTextString(productVal);
    if (!prodStr || !labelStr) return;

    if (!valuesMatch(labelStr, prodStr)) {
      verdicts.push({
        path,
        label: { en: labelName, ar: labelName },
        status: "FAIL",
        presence: "PRESENT",
        severity: "error",
        layer: "product_match",
        comparison: "data_mismatch",
        ruleKey: `PRODUCT_DATA_MISMATCH.${path.toUpperCase()}`,
        message: `Label states "${labelStr}" while product record states "${prodStr}".`,
        citation: null,
        sourceDocumentId: null,
        autoFixable: false,
        suggestion: prodStr,
        triggeredBy: null,
        observed: labelStr,
        expected: prodStr,
        remediation: {
          action: "correct",
          suggested: prodStr,
          source: "product_row",
          sourceRef: { productId: product.id, field: path },
        },
      });
    }
  };

  checkField("productName", "Product Name", labelData.productName, product.name);
  checkField("strength", "Strength", labelData.strength, product.strength);
  checkField("pharmaceuticalForm", "Pharmaceutical Form", labelData.pharmaceuticalForm, product.dosageForm || product.physicalForm);
  checkField("routeOfAdministration", "Route of Administration", labelData.routeOfAdministration, product.routeOfAdmin);
  checkField("withdrawalPeriod", "Withdrawal Period", labelData.withdrawalPeriod, product.withdrawalPeriod);
  checkField("registrationNumber", "Registration Number", labelData.registrationNumber, product.registrationNumber);

  return verdicts;
}

/**
 * §14.5.3: Extraction confidence evaluation.
 * If confidence < threshold (default 0.75), emit status="NEEDS_CONFIRMATION"
 * rather than FAIL, providing bbox and snippet context for human confirmation.
 */
function checkExtractionConfidence(extractionMeta, threshold = 0.75) {
  if (!extractionMeta || typeof extractionMeta !== "object") return { unconfirmedPaths: new Set(), verdicts: [] };

  const unconfirmedPaths = new Set();
  const verdicts = [];

  for (const [path, meta] of Object.entries(extractionMeta)) {
    if (meta && typeof meta.confidence === "number" && meta.confidence < threshold) {
      unconfirmedPaths.add(path);
      verdicts.push({
        path,
        label: { en: path, ar: path },
        status: "NEEDS_CONFIRMATION",
        presence: "PRESENT",
        severity: "warning",
        layer: "extraction",
        comparison: "data_mismatch",
        ruleKey: `EXTRACTION.LOW_CONFIDENCE.${path.toUpperCase()}`,
        message: "Unable to read this field with confidence — confirm it yourself.",
        citation: null,
        sourceDocumentId: null,
        autoFixable: false,
        suggestion: null,
        snippet: meta.snippet || null,
        bbox: meta.bbox || null,
        confidence: meta.confidence,
        remediation: { action: "review", suggested: null, source: "none", sourceRef: null },
      });
    }
  }

  return { unconfirmedPaths, verdicts };
}

/**
 * The one validation engine (§4.2, §10, §14.5) — same labelData + same rules produces
 * the same verdicts for layers 1-4.
 *
 * rules: RegulatoryRule[]-shaped array
 * product: optional Product row from DB for 3-way verification (§14.5.1)
 * extractionMeta: optional { [path]: { confidence, bbox, snippet } } (§14.5.3)
 * confidenceThreshold: number (default 0.75)
 * includePlausibility: layer 6 (§14.5.7), async/AI, defaults to true
 * referenceGroundingFailed: set when ingredient extraction failed (Invariant #7)
 * plausibilityDeps: injectable judgeFn/resolveFn for test seams
 */
export const validate = async (
  labelData,
  {
    rules = [],
    product = null,
    extractionMeta = null,
    confidenceThreshold = 0.75,
    includePlausibility = true,
    referenceGroundingFailed = false,
    plausibilityDeps = {},
  } = {}
) => {
  // 1. Extraction confidence check (§14.5.3)
  const { unconfirmedPaths, verdicts: extractionVerdicts } = checkExtractionConfidence(extractionMeta, confidenceThreshold);

  // 2. Deterministic layers 1-4
  const schemaVerdicts = schemaValidator.run(labelData);
  let layer12Verdicts = applyApplicabilityLayer(labelData, schemaVerdicts);
  const ruleVerdicts = ruleValidator.run(labelData, rules);
  const coherenceVerdicts = coherenceValidator.run(labelData);

  // If a field has low extraction confidence, do not fail it at the schema/applicability layer
  if (unconfirmedPaths.size > 0) {
    layer12Verdicts = layer12Verdicts.filter((v) => !unconfirmedPaths.has(v.path));
  }

  // 3. Grounding failure check (Invariant #7)
  const groundingVerdicts = referenceGroundingFailed ? [buildGroundingFailureVerdict()] : [];

  // 4. 3-Way verification against Product facts (§14.5.1)
  const productVerdicts = checkProductDataMatch(labelData, product, unconfirmedPaths);

  // 5. Layer 6 Plausibility (§14.5.7)
  const plausibilityVerdicts = includePlausibility ? await plausibilityValidator.run(labelData, plausibilityDeps) : [];

  // Combine all verdicts
  const rawVerdicts = [
    ...extractionVerdicts,
    ...layer12Verdicts,
    ...ruleVerdicts,
    ...coherenceVerdicts,
    ...groundingVerdicts,
    ...productVerdicts,
    ...plausibilityVerdicts,
  ];

  // Enforce remediation & comparison invariants on every verdict (§14.5.5)
  const verdicts = rawVerdicts.map((v) => {
    const verdictCopy = { ...v };
    if (!verdictCopy.comparison) {
      if (verdictCopy.layer === "regulatory_rule" || verdictCopy.layer === "applicability") {
        verdictCopy.comparison = "regulatory";
      } else if (verdictCopy.layer === "plausibility") {
        verdictCopy.comparison = "plausibility";
      } else if (verdictCopy.layer === "product_match" || verdictCopy.layer === "extraction") {
        verdictCopy.comparison = "data_mismatch";
      } else {
        verdictCopy.comparison = "coherence";
      }
    }

    if (verdictCopy.status === "FAIL" && !verdictCopy.remediation) {
      verdictCopy.remediation = {
        action: verdictCopy.presence === "MISSING" ? "add" : "correct",
        suggested: null,
        source: verdictCopy.layer === "regulatory_rule" ? "rule" : "none",
        sourceRef: verdictCopy.ruleKey ? { ruleKey: verdictCopy.ruleKey } : null,
      };
    }

    // Invariant #5 / §8.2: Restricted fields NEVER have model-guessed suggestions
    if (verdictCopy.remediation && RESTRICTED_SUGGESTION_FIELDS.has(verdictCopy.path)) {
      if (verdictCopy.remediation.source !== "product_row" && verdictCopy.remediation.source !== "rule") {
        verdictCopy.remediation.suggested = null;
      }
    }

    // §UI redesign item 2: every remediation carries a confidence derived from
    // its source — also doubles as a hard check that no validator emitted an
    // unrecognized source string.
    if (verdictCopy.remediation) {
      const src = verdictCopy.remediation.source;
      if (!(src in REMEDIATION_CONFIDENCE_BY_SOURCE)) {
        throw new Error(`validationEngine: remediation.source "${src}" at path "${verdictCopy.path}" is not a recognized value (expected one of ${Object.keys(REMEDIATION_CONFIDENCE_BY_SOURCE).join(", ")}).`);
      }
      if (verdictCopy.remediation.confidence === undefined) {
        verdictCopy.remediation.confidence = REMEDIATION_CONFIDENCE_BY_SOURCE[src];
      }
    }

    // §UI redesign item 1: whySource + defaults for the new discriminant fields.
    if (!verdictCopy.whySource) {
      verdictCopy.whySource = WHY_SOURCE_BY_LAYER[verdictCopy.layer] || "structure";
    }
    if (verdictCopy.triggeredBy === undefined) verdictCopy.triggeredBy = null;
    if (verdictCopy.observed === undefined) verdictCopy.observed = null;
    if (verdictCopy.expected === undefined) verdictCopy.expected = null;

    return verdictCopy;
  });

  const errorCount = verdicts.filter((v) => v.status === "FAIL").length;
  const warningCount = verdicts.filter((v) => v.status === "WARN" || v.status === "NEEDS_REVIEW" || v.status === "NEEDS_CONFIRMATION").length;
  const passed = verdicts.every((v) => v.status !== "FAIL");

  return {
    passed,
    errorCount,
    warningCount,
    verdicts,
    coveragePercent: null,
    engineVersion: ENGINE_VERSION,
    rulesetIds: rules.map((r) => r.id).filter(Boolean),
    aiAssisted: includePlausibility,
  };
};
