// Tests that only an injectable is tested for (27 Nov QA follow-up): Sterility, Pyrogen, Endotoxins. For an
// ORAL product (a liquid supplement, a powder, a premix…) its result is "N/A" — a rule the product's own
// data decides, shown as such, never asked every time. An injectable, or a product whose route the data
// doesn't settle, keeps the result asked (a lab result is never invented). Pure.

export const PARENTERAL_TESTS = /\b(?:steril|pyrogen|endotoxin)/i;
const INJECTABLE = /inject|parenteral|\bI\.?M\.?\b|\bI\.?V\.?\b|\bS\.?C\.?\b|intramuscular|subcutaneous|intravenous|ampoule|vial/i;
const ORAL_ROUTE = /\boral|drinking\s+water|in\s+(?:the\s+)?feed|per\s+os|mouth|بالفم|مياه\s+الشرب/i;
const ORAL_FORM = /powder|granul|premix|tablet|bol(?:us|i)|paste|pellet|crumble|mash|lick|block/i;
const SUPPLEMENT = /supplement|vitamin|feed|additive|herbal|mineral|probiotic|nutrition/i;

/** The product's route as its data says → "injectable" | "oral" | null (not settled) */
export function routeOf(product = {}) {
  const what = [product.productType, product.productForm, product.category?.name, product.dosageForm, product.physicalForm, product.routeOfAdmin].filter(Boolean).join(" ");
  if (INJECTABLE.test(what)) return "injectable";
  if (ORAL_ROUTE.test(product.routeOfAdmin || "")) return "oral";
  if (ORAL_FORM.test(product.physicalForm || "") || ORAL_FORM.test(product.dosageForm || "")) return "oral";
  if (/liquid|solution|suspension|syrup|emulsion/i.test(product.physicalForm || "") && SUPPLEMENT.test([product.productType, product.category?.name, product.productForm].filter(Boolean).join(" "))) return "oral";
  return null;
}

/** A lab-result field this product has no such test for → { value: "N/A", basis } | null */
export function notApplicable(field, product) {
  if (!field?.isLabResult || !PARENTERAL_TESTS.test(`${field.key || ""} ${field.label || ""}`)) return null;
  if (routeOf(product || {}) !== "oral") return null;
  const test = String(field.label || field.key).replace(/\s*result\s*$/i, "").replace(/^result_/, "");
  return { value: "N/A", basis: `${test} is tested only on injectables; ${product?.name || "this product"} is an oral product (${[product?.physicalForm, product?.productType || product?.category?.name].filter(Boolean).join(", ")})` };
}
