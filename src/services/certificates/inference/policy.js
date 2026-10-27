// What may be inferred or fetched for a certificate field (plan.md §14.1, A5).
// A certificate of analysis states measured, batch-specific facts; filling those
// from inference or the internet would make it false. So the line is drawn in
// CODE, never by prompt:
//   - two PROTECTED classes are never generated, on any path (owner, 2026-10-27): lab results
//     (isLabResult) and batch facts (isBatchFact: batch / lot number, production / manufacturing
//     / expiry date) — they come only from the invoice, a supplier COA, a packing list or a person;
//   - everything else may be generated (owner, 2026-10-27): its default is product_facts_and_web,
//     except values the invoice / company / fixed text own (by category or source);
//   - every field has an `inferencePolicy`: never | product_facts | product_facts_and_web;
//     a person may tighten a policy, never loosen it past the default;
//   - whatever is stored, quantity / invoice / document-number / result fields are `never`
//     (hard guard on the source and the label, for fields categorised wrongly);
//   - registration numbers: never inferred (tier I), and from the web only from
//     an official registry page (§14.3).

export const POLICIES = ["never", "product_facts", "product_facts_and_web"];
const RANK = { never: 0, product_facts: 1, product_facts_and_web: 2 };
const NEVER_CATEGORIES = new Set(["batch_data", "invoice_line", "invoice_header", "company", "constant"]);

// labels that name a measured or per-shipment / per-document value, whatever the category says
// (batch / lot / dates are batch facts: an owner-editable flag, pre-set by BATCH_FACT_LABEL)
const HARD_NEVER_LABEL = /\b(quantity|qty|invoice|(document|certificate)\s*(no|number|#)|result|found|analy[sz]ed|tested|measured|net\s*weight|gross\s*weight)\b/i;
// batch / lot, production / manufacturing / expiry dates (same rule as the migration's pre-set)
const BATCH_FACT_LABEL = /\b(batch|lot|expir\w*|exp\.?\s*date|best\s*before|use\s*by|(production|manufactur\w*|mfg|mfd|prod\.?)\s*(date|dt))\b/i;
const BATCH_FACT_PATHS = new Set(["batchNo", "lotNo", "expiryDate", "productionDate", "manufacturingDate"]);
const REGISTRATION_LABEL = /\b(registration|reg\.?\s*(no|number|#)|licen[cs]e\s*(no|number|#)|marketing\s*authori[sz]ation)\b/i;

/**
 * The default for a field (owner, 2026-10-27): a protected field → never; a value the invoice /
 * company / fixed text owns (by category) → never; everything else → product_facts_and_web.
 */
export function defaultPolicy(field) {
  if (isProtected(field)) return "never";
  const category = field?.dataCategory ?? null;
  if (category && NEVER_CATEGORIES.has(category)) return "never";
  return "product_facts_and_web";
}

// The owner's lab-result pre-set (2026-10-24): a label naming a result, an
// assay or a pass/fail word is a per-batch analysis result until the owner
// unticks it in "Mark fields". Same rule as the migration's backfill.
const LAB_RESULT_LABEL = /\b(results?|assay|complies|conforms?)\b/i;

/** The pre-set for a field whose owner hasn't decided yet: batch data, or a result-like label. */
export const defaultIsLabResult = (field) => field?.dataCategory === "batch_data" || LAB_RESULT_LABEL.test(String(field?.label || ""));

/**
 * A per-batch analysis result: measured once per batch, so it only ever comes from
 * a supplier COA, a previous result of the same batch, or a person. The stored flag
 * decides; batch_data is a lab result whatever the flag says (the category predates it).
 */
export const isLabResult = (field) => field?.isLabResult === true || field?.dataCategory === "batch_data";

/** The pre-set for a field whose owner hasn't decided: a batch / lot / production / expiry label, or the invoice line's batch / date. */
export const defaultIsBatchFact = (field) => !isLabResult(field) && (BATCH_FACT_LABEL.test(String(field?.label || "")) || (field?.source?.kind === "item" && BATCH_FACT_PATHS.has(String(field.source.path || ""))));

/** A batch fact: the owner's tick decides (true / false); not decided (null / absent) → the pre-set. */
export const isBatchFact = (field) => (typeof field?.isBatchFact === "boolean" ? field.isBatchFact : defaultIsBatchFact(field));

/** Never generated, on any path: a lab result or a batch fact (owner, 2026-10-27). */
export const isProtected = (field) => isLabResult(field) || isBatchFact(field);

/** Code's hard line: true when nothing may be inferred or fetched for this field, whatever is stored. */
export function hardNever(field) {
  if (isProtected(field)) return true;
  if (["item", "invoice", "company", "today", "static"].includes(field?.source?.kind)) return true;
  if (field?.groupKey) return true; // group cells come from their declared list
  if (field?.source?.kind === "template" && /\{\{\s*(item|invoice)\b/.test(String(field.source.template || ""))) return true;
  return HARD_NEVER_LABEL.test(String(field?.label || "")) && !REGISTRATION_LABEL.test(String(field?.label || ""));
}

export const isRegistrationField = (field) => REGISTRATION_LABEL.test(String(field?.label || "")) || /registrationNumber/.test(String(field?.source?.path || ""));

/** The stricter of two policies. */
export const stricter = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** What a field may actually use: its stored policy, never looser than the default, and the hard line. */
export function effectivePolicy(field) {
  if (hardNever(field)) return "never";
  const stored = POLICIES.includes(field?.inferencePolicy) ? field.inferencePolicy : defaultPolicy(field);
  return stricter(stored, defaultPolicy(field));
}

/**
 * May this field use tier I — inference from the product's data and general knowledge of its
 * type (owner, 2026-10-27)? Never a protected field (hard line); registration numbers: no.
 */
export const allowsInference = (field) => RANK[effectivePolicy(field)] >= RANK.product_facts && !isRegistrationField(field);
/** May this field use tier W (web)? */
export const allowsWeb = (field) => effectivePolicy(field) === "product_facts_and_web";

/**
 * May this field use tier C (the product's own catalogue block, plan.md §15.5)?
 * Product data only — by category, and the same hard line in code: batch data /
 * lab results, invoice values, dates, quantities and document numbers never come
 * from a catalogue, whatever the field's category says. A catalogue is the
 * supplier's document, not inference, so a person's inference policy doesn't
 * turn it off; registration numbers printed in it are fine.
 */
export const allowsCatalogue = (field) => !hardNever(field) && defaultPolicy(field) !== "never";

/**
 * The policy to store for a field a person saved (PUT …/fields): their choice,
 * clamped so it is never looser than the default. → policy
 */
export function policyToStore(field, requested) {
  if (isProtected(field)) return "never";
  const d = defaultPolicy(field);
  if (!POLICIES.includes(requested)) return d;
  return stricter(requested, d);
}
