// What may be inferred or fetched for a certificate field (plan.md §14.1, A5).
// A certificate of analysis states measured, batch-specific facts; filling those
// from inference or the internet would make it false. So the line is drawn in
// CODE, never by prompt:
//   - every field has an `inferencePolicy`: never | product_facts | product_facts_and_web;
//   - its default comes from the category — only product data may use tiers I/W;
//   - a person may tighten a policy, never loosen it past the default;
//   - whatever is stored, batch/date/quantity/document/result fields are `never`
//     (hard guard on the source and the label, for fields categorised wrongly);
//   - registration numbers: never inferred (tier I), and from the web only from
//     an official registry page (§14.3).

export const POLICIES = ["never", "product_facts", "product_facts_and_web"];
const RANK = { never: 0, product_facts: 1, product_facts_and_web: 2 };
const NEVER_CATEGORIES = new Set(["batch_data", "invoice_line", "invoice_header", "company", "constant"]);

// labels that name a measured / per-batch / per-shipment value, whatever the category says
const HARD_NEVER_LABEL = /\b(batch|lot|expir\w*|exp\.?|production|manufactur\w*\s*date|mfg|mfd|prod\.?\s*date|quantity|qty|invoice|document|certificate\s*(no|number|#)|result|found|analy[sz]ed|tested|measured|net\s*weight|gross\s*weight)\b/i;
const REGISTRATION_LABEL = /\b(registration|reg\.?\s*(no|number|#)|licen[cs]e\s*(no|number|#)|marketing\s*authori[sz]ation)\b/i;

/** The default for a field (§14.1): product data → product_facts_and_web; everything else → never. */
export function defaultPolicy(field) {
  const category = field?.dataCategory ?? null;
  if (category && NEVER_CATEGORIES.has(category)) return "never";
  if (category === "product_data") return "product_facts_and_web";
  return ["product", "brand"].includes(field?.source?.kind) ? "product_facts_and_web" : "never";
}

/** Code's hard line: true when nothing may be inferred or fetched for this field, whatever is stored. */
export function hardNever(field) {
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

/** May this field use tier I (inference from product data)? Registration numbers: no. */
export const allowsInference = (field) => RANK[effectivePolicy(field)] >= RANK.product_facts && !isRegistrationField(field);
/** May this field use tier W (web)? */
export const allowsWeb = (field) => effectivePolicy(field) === "product_facts_and_web";

/**
 * The policy to store for a field a person saved (PUT …/fields): their choice,
 * clamped so it is never looser than the default. → policy
 */
export function policyToStore(field, requested) {
  const d = defaultPolicy(field);
  if (!POLICIES.includes(requested)) return d;
  return stricter(requested, d);
}
