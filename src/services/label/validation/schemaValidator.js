import { labelSchema } from "../schema/labelSchema.js";

const FIELD_LABELS = {
  productName: { en: "Product Name", ar: "اسم المنتج" },
  targetAnimalSpecies: { en: "Target Animals", ar: "الأنواع المستهدفة" },
  activeIngredients: { en: "Active Ingredients", ar: "المكونات الفعالة" },
  withdrawalPeriod: { en: "Withdrawal Period", ar: "فترة السحب" },
  directionOfUse: { en: "Direction of Use", ar: "طريقة الاستخدام" },
  storage: { en: "Storage", ar: "التخزين" },
};

const labelFor = (path) => FIELD_LABELS[path] || { en: path, ar: path };

const presenceFor = (issue) => {
  if (issue.code === "invalid_type" && issue.input === undefined) return "MISSING";
  if (issue.code === "too_small" && issue.minimum === 1) return "EMPTY";
  return "INVALID";
};

/**
 * Layer 1 (§10.1) — deterministic, Zod. Emits one FieldVerdict per TOP-LEVEL
 * labelSchema key: FAIL if any Zod issue touches that key (nested or not), PASS
 * otherwise. Layer 2 (applicability, in validationEngine.js) may override these
 * for catalogued fields.
 */
export const run = (labelData) => {
  const result = labelSchema.safeParse(labelData);
  const topLevelKeys = Object.keys(labelSchema.shape);

  if (result.success) {
    return topLevelKeys.map((path) => ({
      path,
      label: labelFor(path),
      status: "PASS",
      presence: "PRESENT",
      severity: "error",
      layer: "schema",
      comparison: "coherence",
      ruleKey: null,
      message: null,
      citation: null,
      sourceDocumentId: null,
      autoFixable: false,
      suggestion: null,
      remediation: null,
    }));
  }

  const issuesByTopKey = new Map();
  for (const issue of result.error.issues) {
    const topKey = issue.path[0];
    if (!issuesByTopKey.has(topKey)) issuesByTopKey.set(topKey, issue);
  }

  return topLevelKeys.map((path) => {
    const issue = issuesByTopKey.get(path);
    if (!issue) {
      return {
        path,
        label: labelFor(path),
        status: "PASS",
        presence: "PRESENT",
        severity: "error",
        layer: "schema",
        comparison: "coherence",
        ruleKey: null,
        message: null,
        citation: null,
        sourceDocumentId: null,
        autoFixable: false,
        suggestion: null,
        remediation: null,
      };
    }
    const presence = presenceFor(issue);
    return {
      path,
      label: labelFor(path),
      status: "FAIL",
      presence,
      severity: "error",
      layer: "schema",
      comparison: "coherence",
      ruleKey: `SCHEMA.${String(path).toUpperCase()}.INVALID`,
      message: issue.message,
      citation: null,
      sourceDocumentId: null,
      autoFixable: false,
      suggestion: null,
      remediation: { action: presence === "MISSING" ? "add" : "correct", suggested: null, source: "none", sourceRef: null },
    };
  });
};
