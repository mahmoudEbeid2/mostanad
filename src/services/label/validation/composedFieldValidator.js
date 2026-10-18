// §5 — "validation follows the composed list": once a composer.js field list
// exists for a generation/validation call, iterate THAT instead of a
// hardcoded array. Opt-in (validationEngine.validate only runs this when
// `composedFields` is passed) so every existing caller without a composed
// schema yet keeps today's behavior unchanged.
//
// Only catalog-CONTRIBUTED fields are handled here — pure core fields
// (contributedBy.length === 0) are already fully covered by schemaValidator
// (layer 1) and fieldCatalog's applicability layer (layer 2); re-asserting
// them here would just duplicate those verdicts.
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

const labelFor = (path) => ({ en: path, ar: path });

/**
 * composedFields: composer.js's buildLabelSchema(...).fields.
 * rules: the same RegulatoryRule[] passed to ruleValidator — used only to
 * check whether a composed field's content is actually covered by a
 * compiled rule, not to re-run it.
 */
export const run = (labelData, composedFields = [], rules = []) => {
  const coveredPaths = new Set(rules.map((r) => r.targetPath).filter(Boolean));
  const verdicts = [];

  for (const f of composedFields) {
    if (f.contributedBy.length === 0) continue; // pure core field — layers 1-2 already speak for it

    const value = getPlain(labelData, f.key);
    const missing = isEmptyValue(value);
    const mustBePresent = f.requirement === "required" || f.requirement === "conditional";

    if (mustBePresent && missing) {
      verdicts.push({
        path: f.key,
        label: labelFor(f.key),
        status: "FAIL",
        presence: "MISSING",
        severity: "error",
        layer: "applicability",
        comparison: "regulatory",
        ruleKey: `CATALOG.${f.key.toUpperCase()}.REQUIRED`,
        message: `"${f.key}" is required by ${f.contributedBy.length} contributing regulatory document(s) but is missing.`,
        citation: f.contributedBy[0]?.quote || null,
        sourceDocumentId: f.contributedBy[0]?.documentId || null,
        autoFixable: false,
        suggestion: null,
        triggeredBy: null,
        observed: null,
        expected: null,
        remediation: { action: "add", suggested: null, source: "rule", sourceRef: { ruleKey: `CATALOG.${f.key.toUpperCase()}.REQUIRED` } },
      });
      continue;
    }

    // §5's own rule: a composed field with no applicable rule is UNVERIFIABLE,
    // never a silent PASS-by-omission — presence alone was checked above and
    // is fine, but nothing here confirms CONTENT/format/language compliance
    // unless a compiled RegulatoryRule actually targets this path.
    if (mustBePresent && !missing && !coveredPaths.has(f.key)) {
      verdicts.push({
        path: f.key,
        label: labelFor(f.key),
        status: "UNVERIFIABLE",
        presence: "PRESENT",
        severity: "warning",
        layer: "applicability",
        comparison: "regulatory",
        ruleKey: `CATALOG.${f.key.toUpperCase()}.NO_COMPILED_RULE`,
        message: `"${f.key}" is present and is required by a contributing document, but no compiled regulatory rule verifies its content — presence alone was checked, not correctness.`,
        citation: f.contributedBy[0]?.quote || null,
        sourceDocumentId: f.contributedBy[0]?.documentId || null,
        autoFixable: false,
        suggestion: null,
        triggeredBy: null,
        observed: null,
        expected: null,
        remediation: null,
      });
    }
  }

  return verdicts;
};
