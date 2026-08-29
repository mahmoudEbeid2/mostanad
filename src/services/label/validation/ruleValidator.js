// Layer 3 (§10.1) — deterministic runner for RegulatoryRule.constraint (§7.3's DSL).
// Takes `rules` as a plain array so it works standalone before Phase 3's
// RegulatoryRule table exists (pass fixture rules, or []) and after (pass real
// rows). No AI involved — semantic-kind rules are explicitly routed to Phase 5's
// aiValidator and are marked UNVERIFIABLE here, never silently skipped.

// Resolves a dotted/bracketed path against labelData. Supports a single `[*]`
// wildcard segment (e.g. "activeIngredients[*].amount"), returning one entry per
// array element. Everything else returns exactly one entry.
const resolvePath = (labelData, path) => {
  const wildcardMatch = path.match(/^(.+)\[\*\]\.(.+)$/);
  if (wildcardMatch) {
    const [, arrayPath, subPath] = wildcardMatch;
    const arr = getPlain(labelData, arrayPath);
    if (!Array.isArray(arr)) return [];
    return arr.map((item, i) => ({ path: `${arrayPath}[${i}].${subPath}`, value: getPlain(item, subPath) }));
  }
  return [{ path, value: getPlain(labelData, path) }];
};

const getPlain = (obj, path) =>
  path.split(".").reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);

// Flattens all text out of a value — a plain string, or a LocalizedText object
// (translations + primary) — for content/format checks that must scan every language.
const extractText = (value) => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "object" && value.translations) {
    return Object.values(value.translations).filter((v) => typeof v === "string");
  }
  return [];
};

const isEmpty = (value) => {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "object" && "translations" in value) {
    return Object.keys(value.translations || {}).length === 0 || !value.primary;
  }
  return false;
};

function evaluateWhen(labelData, when) {
  const { value } = resolvePath(labelData, when.path)[0];
  if (when.anyOf) {
    const list = Array.isArray(value) ? value : [value];
    return list.some((v) => when.anyOf.some((expected) => (v || "").toString().toLowerCase() === expected.toLowerCase()));
  }
  throw new Error(`ruleValidator: unsupported "when" shape for path "${when.path}" — no anyOf given.`);
}

// FieldVerdict.triggeredBy (§UI redesign item 1): the condition that made a
// conditional rule apply to THIS label, in plain words — "today the user sees
// a rule fired but not why it applied to them". Only meaningful for `anyOf`
// conditions (the only "when" shape this engine supports); returns null when
// it can't produce a real match list rather than a vague restatement.
function describeWhen(labelData, when) {
  const { value } = resolvePath(labelData, when.path)[0];
  if (!when.anyOf) return null;
  const list = Array.isArray(value) ? value : [value];
  const matched = list.filter((v) => when.anyOf.some((expected) => (v || "").toString().toLowerCase() === expected.toLowerCase()));
  if (matched.length === 0) return null;
  return `this label's "${when.path}" includes ${matched.join(", ")}`;
}

function ruleTriggeredBy(labelData, rule) {
  if (rule.appliesWhen) {
    const d = describeWhen(labelData, rule.appliesWhen);
    if (d) return d;
  }
  if (rule.constraint?.kind === "conditional" && rule.constraint.when) {
    const d = describeWhen(labelData, rule.constraint.when);
    if (d) return d;
  }
  return null;
}

// Evaluates one constraint payload against labelData, returning [{path, ok, message}].
// Throws on an unrecognized "kind" — an unsupported DSL parameter is a hard error,
// never a silent skip (§7.3's own rule).
function evaluateConstraint(labelData, constraint) {
  switch (constraint.kind) {
    case "required_field": {
      const { path, minLength = 1 } = constraint;
      const entries = resolvePath(labelData, path);
      return entries.map(({ path: p, value }) => {
        const length = Array.isArray(value) ? value.length : isEmpty(value) ? 0 : 1;
        return { path: p, ok: length >= minLength, message: `"${p}" must be present (minLength ${minLength}).` };
      });
    }
    case "forbidden_content": {
      const { path, patterns, flags = "i" } = constraint;
      const entries = resolvePath(labelData, path);
      return entries.flatMap(({ path: p, value }) =>
        extractText(value).map((text) => {
          const hit = patterns.find((pattern) => new RegExp(pattern, flags).test(text));
          return { path: p, ok: !hit, message: hit ? `"${p}" contains forbidden pattern /${hit}/.` : null };
        })
      );
    }
    case "format": {
      const { path, regex, message } = constraint;
      const entries = resolvePath(labelData, path);
      return entries.flatMap(({ path: p, value }) => {
        const texts = extractText(value);
        if (texts.length === 0) return [{ path: p, ok: true, message: null }];
        return texts.map((text) => ({ path: p, ok: new RegExp(regex).test(text), message: message || `"${p}" does not match required format.` }));
      });
    }
    case "value_constraint": {
      const { path, notEmpty } = constraint;
      const entries = resolvePath(labelData, path);
      return entries.map(({ path: p, value }) => ({
        path: p,
        ok: notEmpty ? !isEmpty(value) : true,
        message: `"${p}" must not be empty.`,
      }));
    }
    case "language_set": {
      const { required, appliesTo } = constraint;
      const paths = appliesTo === "*" ? findLocalizedTextPaths(labelData) : [appliesTo];
      return paths.flatMap((p) => {
        const value = getPlain(labelData, p);
        if (!value || !value.translations) return [];
        const missing = required.filter((lang) => !(lang in value.translations));
        return [{ path: p, ok: missing.length === 0, message: missing.length ? `"${p}" is missing language(s): ${missing.join(", ")}.` : null }];
      });
    }
    case "conditional": {
      if (!evaluateWhen(labelData, constraint.when)) return [];
      return evaluateConstraint(labelData, constraint.then);
    }
    case "semantic":
      // Routed to Phase 5's aiValidator — not evaluable deterministically.
      return [{ path: constraint.path || "_semantic", ok: null, message: null, semantic: true }];
    default:
      throw new Error(`ruleValidator: unsupported constraint.kind "${constraint.kind}" — refusing to silently ignore it.`);
  }
}

// Best-effort discovery of every LocalizedText-shaped field at the top level,
// for language_set's appliesTo:"*". A field counts if it has both `translations`
// and `primary` keys.
function findLocalizedTextPaths(labelData) {
  return Object.entries(labelData)
    .filter(([, v]) => v && typeof v === "object" && "translations" in v && "primary" in v)
    .map(([k]) => k);
}

/**
 * rules: RegulatoryRule[]-shaped array — { id?, ruleKey, ruleType, severity,
 * targetPath, appliesWhen, constraint, description, citation }.
 * Returns FieldVerdict[] for layer "regulatory_rule". An empty `rules` array is
 * NOT silently skipped — it produces one UNVERIFIABLE verdict per §7.1 case 4
 * (NO_AUTHORITATIVE_REQUIREMENTS), so "we have no rules yet" is always visible.
 */
export const run = (labelData, rules = []) => {
  if (rules.length === 0) {
    return [{
      path: "_regulatory",
      label: { en: "Regulatory Requirements", ar: "المتطلبات التنظيمية" },
      status: "UNVERIFIABLE",
      presence: "MISSING",
      severity: "warning",
      layer: "regulatory_rule",
      comparison: "regulatory",
      ruleKey: "NO_AUTHORITATIVE_REQUIREMENTS",
      message: "No approved regulatory rules exist yet for this country/product scope.",
      citation: null,
      sourceDocumentId: null,
      autoFixable: false,
      suggestion: null,
      remediation: null,
    }];
  }

  const verdicts = [];
  for (const rule of rules) {
    if (rule.appliesWhen && !evaluateWhen(labelData, rule.appliesWhen)) continue;
    const triggeredBy = ruleTriggeredBy(labelData, rule);

    const results = evaluateConstraint(labelData, rule.constraint);
    for (const r of results) {
      if (r.semantic) {
        verdicts.push({
          path: r.path, label: labelFor(r.path), status: "UNVERIFIABLE", presence: "PRESENT",
          severity: rule.severity, layer: "semantic", comparison: "regulatory", ruleKey: rule.ruleKey,
          message: "Semantic check deferred to AI validator (Phase 5).", citation: rule.citation,
          sourceDocumentId: rule.documentId || null, autoFixable: false, suggestion: null,
          triggeredBy, observed: null, expected: null,
          remediation: null,
        });
        continue;
      }
      const isFail = !r.ok && rule.severity !== "warning";
      const isWarn = !r.ok && rule.severity === "warning";
      verdicts.push({
        path: r.path,
        label: labelFor(r.path),
        status: r.ok ? "PASS" : (isWarn ? "WARN" : "FAIL"),
        presence: r.ok ? "PRESENT" : "MISSING",
        severity: rule.severity,
        layer: "regulatory_rule",
        comparison: "regulatory",
        ruleKey: rule.ruleKey,
        message: r.ok ? null : (r.message || rule.description),
        citation: rule.citation || null,
        sourceDocumentId: rule.documentId || null,
        autoFixable: rule.autoFixable || false,
        suggestion: null,
        triggeredBy,
        observed: null,
        expected: null,
        remediation: isFail ? {
          action: r.presence === "MISSING" ? "add" : "correct",
          suggested: null,
          source: "rule",
          sourceRef: { ruleKey: rule.ruleKey, documentId: rule.documentId || null },
        } : null,
      });
    }
  }
  return verdicts;
};

const labelFor = (path) => ({ en: path, ar: path });
