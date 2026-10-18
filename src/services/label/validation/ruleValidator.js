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

// Flattens all text out of a value — a plain string, a LocalizedText object
// (translations + primary), or an ARRAY of either (labelSchema.js has several
// z.array(LocalizedText) fields — excipients, warnings, indications,
// userSafety, usageDeclaration — a content/format rule targeting one of those
// must scan every element's every language, not silently see an array and
// produce zero text to check, which would make forbidden_content a silent
// no-op on exactly the fields real ingredient/claim restrictions target).
const extractText = (value) => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
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
      // §4 (prohibited_phrase): a deny list PLUS an optional allow list of
      // otherwise-similar accepted terms — a document that rejects "vegetable
      // oils" but accepts "grains" cannot be expressed by a deny list alone.
      // A deny-pattern match is only a violation if that SAME matched text
      // does not also satisfy an allow pattern.
      const { path, patterns, flags = "i", allow = [] } = constraint;
      const searchFlags = flags.includes("g") ? flags : `${flags}g`;
      const allowRegexes = allow.map((p) => new RegExp(p, flags));
      const entries = resolvePath(labelData, path);
      return entries.flatMap(({ path: p, value }) =>
        extractText(value).map((text) => {
          let hitPattern = null;
          let hitText = null;
          for (const pattern of patterns) {
            const re = new RegExp(pattern, searchFlags);
            let m;
            while ((m = re.exec(text)) !== null) {
              const exempt = allowRegexes.some((a) => a.test(m[0]));
              if (!exempt) { hitPattern = pattern; hitText = m[0]; break; }
              if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length matches looping forever
            }
            if (hitPattern) break;
          }
          return {
            path: p,
            ok: !hitPattern,
            message: hitPattern ? `"${p}" contains forbidden pattern /${hitPattern}/ ("${hitText}"), which is not on the allow-list.` : null,
          };
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
    // §4: a numeric value with an operator, a bound, and (in the DB row's
    // `description`) the stated consequence — the consequence is documentary,
    // not a code branch, so no new code path per consequence text is needed.
    case "numeric_threshold": {
      const { path, operator, bound, unit } = constraint;
      const entries = resolvePath(labelData, path);
      return entries.flatMap(({ path: p, value }) => {
        const texts = extractText(value);
        if (texts.length === 0) {
          return [{ path: p, ok: false, message: `"${p}" must state a numeric value (needed to check ${operator} ${bound}${unit ? " " + unit : ""}).` }];
        }
        return texts.map((text) => {
          const match = text.match(/-?\d+(?:\.\d+)?/);
          if (!match) return { path: p, ok: false, message: `"${p}" ("${text}") does not contain a numeric value.` };
          const observed = parseFloat(match[0]);
          const ok = compareNumeric(observed, operator, bound);
          return {
            path: p,
            ok,
            message: ok ? null : `"${p}" is ${observed}${unit ? " " + unit : ""}, which does not satisfy "${operator} ${bound}${unit ? " " + unit : ""}".`,
          };
        });
      });
    }
    // §4: a field's value must be one of a stated set.
    case "enumerated_values": {
      const { path, allowed } = constraint;
      const allowedLower = allowed.map((a) => a.toString().toLowerCase().trim());
      const entries = resolvePath(labelData, path);
      return entries.flatMap(({ path: p, value }) => {
        const texts = extractText(value);
        const values = texts.length > 0 ? texts : Array.isArray(value) ? value.map(String) : value !== null && value !== undefined ? [String(value)] : [];
        if (values.length === 0) {
          return [{ path: p, ok: false, message: `"${p}" must be one of: ${allowed.join(", ")}.` }];
        }
        return values.map((v) => {
          const ok = allowedLower.includes(v.toString().toLowerCase().trim());
          return { path: p, ok, message: ok ? null : `"${p}" value "${v}" is not one of the allowed values: ${allowed.join(", ")}.` };
        });
      });
    }
    // §4: the field must match a record in a system this engine cannot query
    // (e.g. an external e-registration database) — this can NEVER resolve to
    // PASS or FAIL deterministically, only to a request for human/external
    // confirmation. Kept distinct from "semantic" (-> UNVERIFIABLE): "please
    // confirm this matches your registration" is not "we could not verify
    // this at all".
    case "external_match":
      return [{ path: constraint.path || "_external_match", ok: null, needsConfirmation: true, message: null }];
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

function compareNumeric(observed, operator, bound) {
  switch (operator) {
    case ">": return observed > bound;
    case ">=": return observed >= bound;
    case "<": return observed < bound;
    case "<=": return observed <= bound;
    case "==": return observed === bound;
    case "!=": return observed !== bound;
    default:
      throw new Error(`ruleValidator: unsupported numeric_threshold operator "${operator}".`);
  }
}

// Self-correction ceiling (§7 of the ingestion overhaul): a rule that would
// otherwise FAIL is capped at NEEDS_REVIEW — never silently passed, never
// silently dropped — when the system has a documented reason to distrust its
// own certainty on THIS rule right now:
//   - the rule's source document activated at partial coverage (decision 1:
//     coverage sets severity, not access — a document stays usable, but
//     nothing it contributes can hard-FAIL until a human/re-audit clears it)
//   - the rule's own extraction confidence is below threshold (§7a)
//   - the rule has been statistically downgraded for failing too often (§7b)
// Reasons are cumulative and all recorded, so a verdict never just says
// "downgraded" without saying why.
const LOW_CONFIDENCE_THRESHOLD = Number(process.env.RULE_LOW_CONFIDENCE_THRESHOLD) || 0.6;

function severityDowngradeReasons(rule) {
  const reasons = [];
  if (rule.documentActivationMode === "partial") {
    reasons.push("source document activated at partial coverage (below the coverage threshold)");
  }
  if (typeof rule.confidence === "number" && rule.confidence < LOW_CONFIDENCE_THRESHOLD) {
    reasons.push(`low extraction confidence (${rule.confidence.toFixed(2)} < ${LOW_CONFIDENCE_THRESHOLD})`);
  }
  if (rule.autoDowngraded) {
    reasons.push(rule.downgradeReason || "statistically downgraded — fails an abnormally high proportion of labels");
  }
  return reasons;
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
      // §4 external_match: never PASS/FAIL — a real "please confirm against
      // the system we can't query", distinct from semantic's UNVERIFIABLE.
      if (r.needsConfirmation) {
        verdicts.push({
          path: r.path, label: labelFor(r.path), status: "NEEDS_CONFIRMATION", presence: "PRESENT",
          severity: rule.severity, layer: "regulatory_rule", comparison: "regulatory", ruleKey: rule.ruleKey,
          message: rule.description || "This value must be confirmed against an external system this engine cannot query.",
          citation: rule.citation || null, sourceDocumentId: rule.documentId || null, autoFixable: false, suggestion: null,
          triggeredBy, observed: null, expected: null,
          remediation: { action: "review", suggested: null, source: "none", sourceRef: { ruleKey: rule.ruleKey, documentId: rule.documentId || null } },
        });
        continue;
      }

      const downgradeReasons = !r.ok ? severityDowngradeReasons(rule) : [];
      const downgraded = downgradeReasons.length > 0 && rule.severity !== "warning";
      const isFail = !r.ok && rule.severity !== "warning" && !downgraded;
      const isWarn = !r.ok && rule.severity === "warning";
      const status = r.ok ? "PASS" : downgraded ? "NEEDS_REVIEW" : isWarn ? "WARN" : "FAIL";
      verdicts.push({
        path: r.path,
        label: labelFor(r.path),
        status,
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
        downgradeReasons: downgraded ? downgradeReasons : null,
        remediation: (isFail || downgraded) ? {
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
